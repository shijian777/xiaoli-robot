import * as fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import {AsrUnavailableError} from './client.mjs';

const transcriptSchema = {
  type: 'object',
  properties: {
    transcript: {type: 'string'},
    unclear: {type: 'boolean'}
  },
  required: ['transcript', 'unclear'],
  additionalProperties: false
};

const validateTranscript = new Ajv({allErrors: true, strict: true}).compile(transcriptSchema);

/**
 * Transcribes Bridge-owned WAV files and removes them after the final result.
 */
export class AsrService {
  #client;
  #asrAgentId;
  #tempDir;
  #whisper;
  #sessions = new Map();

  constructor({client, asrAgentId, tempDir, whisper} = {}) {
    if (!client || typeof client.createSession !== 'function' || typeof client.runAudioTurn !== 'function') {
      throw new TypeError('AsrService requires an Agent Stack client');
    }
    if (typeof asrAgentId !== 'string' || asrAgentId.trim() === '') {
      throw new TypeError('asrAgentId must be a non-empty string');
    }
    if (typeof tempDir !== 'string' || tempDir.trim() === '') {
      throw new TypeError('tempDir must be a non-empty string');
    }
    if (whisper && typeof whisper.transcribe !== 'function') {
      throw new TypeError('whisper must provide transcribe()');
    }
    this.#client = client;
    this.#asrAgentId = asrAgentId;
    this.#tempDir = path.resolve(tempDir);
    this.#whisper = whisper;
  }

  async transcribe(wavPath, {caseId, segmentId} = {}) {
    assertIdentifier(caseId, 'caseId');
    assertIdentifier(segmentId, 'segmentId');
    const bridgeWav = await openBridgeWav(wavPath, this.#tempDir);

    try {
      const wav = await bridgeWav.handle.readFile();
      const sessionId = await this.#sessionFor(caseId);
      try {
        const turn = await this.#client.runAudioTurn(sessionId, wav, `${segmentId}.wav`);
        return extractTranscript(turn?.assistantMessage);
      } catch (error) {
        if (error instanceof AsrUnavailableError && this.#whisper) {
          return this.#whisper.transcribe(bridgeWav.path);
        }
        throw error;
      }
    } finally {
      try {
        await bridgeWav.handle.close();
      } finally {
        await removeBridgeWav(bridgeWav);
      }
    }
  }

  async #sessionFor(caseId) {
    let session = this.#sessions.get(caseId);
    if (!session) {
      session = Promise.resolve(this.#client.createSession(this.#asrAgentId));
      this.#sessions.set(caseId, session);
    }
    try {
      return await session;
    } catch (error) {
      if (this.#sessions.get(caseId) === session) this.#sessions.delete(caseId);
      throw error;
    }
  }
}

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

async function openBridgeWav(wavPath, tempDir) {
  if (typeof wavPath !== 'string' || wavPath.trim() === '') {
    throw new TypeError('wavPath must be a non-empty string');
  }
  const requestedPath = path.resolve(wavPath);
  if (path.extname(requestedPath).toLowerCase() !== '.wav' || !isContainedBy(tempDir, requestedPath)) {
    throw new Error('ASR accepts only a Bridge-created WAV path under tempDir');
  }

  const [realTempDir, realWavPath, wavStats] = await Promise.all([
    fs.realpath(tempDir),
    fs.realpath(requestedPath),
    fs.lstat(requestedPath)
  ]);
  if (wavStats.isSymbolicLink() || !wavStats.isFile() || !isContainedBy(realTempDir, realWavPath)) {
    throw new Error('ASR accepts only a Bridge-created WAV path under tempDir');
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.open(requestedPath, fsConstants.O_RDONLY | noFollow);
    const openedStats = await handle.stat();
    const openedPathStats = await fs.lstat(requestedPath);
    if (!openedStats.isFile() || openedPathStats.isSymbolicLink()) {
      throw new Error('ASR accepts only a Bridge-created WAV path under tempDir');
    }
    return {handle, path: requestedPath, tempDir, realTempDir};
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function removeBridgeWav({path: wavPath, tempDir, realTempDir}) {
  if (!isContainedBy(tempDir, wavPath)) {
    throw new Error('ASR cleanup refused a path outside tempDir');
  }
  let realParent;
  try {
    realParent = await fs.realpath(path.dirname(wavPath));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!isContainedByOrEqual(realTempDir, realParent)) {
    throw new Error('ASR cleanup refused a path outside tempDir');
  }
  await fs.rm(wavPath, {force: true});
}

function isContainedBy(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isContainedByOrEqual(parent, candidate) {
  return parent === candidate || isContainedBy(parent, candidate);
}

function extractTranscript(message) {
  if (typeof message !== 'string') {
    throw new Error('Agent Stack ASR transcript must be a JSON object');
  }
  let result;
  try {
    result = JSON.parse(stripSingleJsonFence(message));
  } catch {
    throw new Error('Agent Stack ASR transcript must be valid JSON');
  }
  if (!validateTranscript(result)) {
    throw new Error('Agent Stack ASR transcript must be exactly {transcript:string,unclear:boolean}');
  }
  const transcript = result.transcript.trim();
  if (transcript === '') {
    throw new Error('Agent Stack ASR transcript must not be empty');
  }
  return transcript;
}

function stripSingleJsonFence(value) {
  const fenced = value.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return fenced ? fenced[1] : value;
}
