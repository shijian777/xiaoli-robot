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
const CLEANUP_RETRY_DELAY_MS = 50;
const CLEANUP_ATTEMPTS = 3;

/**
 * Transcribes Bridge-owned WAV files and removes them after the final result.
 */
export class AsrService {
  #client;
  #asrAgentId;
  #tempDir;
  #whisper;
  #removeFile;
  #sessions = new Map();

  constructor({client, asrAgentId, tempDir, whisper, removeFile = fs.rm} = {}) {
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
    if (typeof removeFile !== 'function') throw new TypeError('removeFile must be a function');
    this.#client = client;
    this.#asrAgentId = asrAgentId;
    this.#tempDir = path.resolve(tempDir);
    this.#whisper = whisper;
    this.#removeFile = removeFile;
  }

  async transcribe(wavPath, {caseId, segmentId, signal} = {}) {
    assertIdentifier(caseId, 'caseId');
    assertIdentifier(segmentId, 'segmentId');
    signal?.throwIfAborted();
    const bridgeWav = await openBridgeWav(wavPath, this.#tempDir);

    try {
      const wav = await bridgeWav.handle.readFile();
      const sessionId = await this.#sessionFor(caseId, signal);
      try {
        const turn = await this.#client.runAudioTurn(sessionId, wav, `${segmentId}.wav`, {signal});
        return extractTranscript(turn?.assistantMessage);
      } catch (error) {
        if (error instanceof AsrUnavailableError && this.#whisper) {
          const fallbackWav = await stageFallbackWav(wav, bridgeWav);
          let cleanupPromise;
          let cleanupDeferred = false;
          const cleanupAfterClose = () => cleanupPromise ??= removeFallbackWav(fallbackWav, this.#removeFile);
          try {
            return await this.#whisper.transcribe(fallbackWav.path, {signal, cleanupAfterClose});
          } catch (fallbackError) {
            cleanupDeferred = fallbackError?.cleanupDeferred === true;
            throw fallbackError;
          } finally {
            if (!cleanupDeferred) await cleanupAfterClose();
          }
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

  forgetCase(caseId) {
    assertIdentifier(caseId, 'caseId');
    this.#sessions.delete(caseId);
  }

  async #sessionFor(caseId, signal) {
    let session = this.#sessions.get(caseId);
    if (!session) {
      session = Promise.resolve(this.#client.createSession(this.#asrAgentId, {signal}));
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

async function stageFallbackWav(wav, bridgeWav) {
  await assertUnchangedTempDir(bridgeWav.tempDir, bridgeWav.realTempDir);
  const directory = await fs.mkdtemp(path.join(bridgeWav.tempDir, 'asr-fallback-'));
  let handle;
  try {
    await fs.chmod(directory, 0o700);
    const realDirectory = await fs.realpath(directory);
    const directoryStats = await fs.lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory() || !isContainedBy(bridgeWav.realTempDir, realDirectory)) {
      throw new Error('ASR fallback staging directory is outside tempDir');
    }

    const fallbackPath = path.join(directory, 'input.wav');
    handle = await fs.open(fallbackPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(wav);
    await handle.close();
    handle = undefined;
    return {
      path: fallbackPath,
      directory,
      tempDir: bridgeWav.tempDir,
      realTempDir: bridgeWav.realTempDir
    };
  } catch (error) {
    await handle?.close();
    await removeFallbackDirectory({directory, tempDir: bridgeWav.tempDir, realTempDir: bridgeWav.realTempDir});
    throw error;
  }
}

async function removeFallbackWav(fallbackWav, removeFile = fs.rm) {
  try {
    await assertPrivateFallbackDirectory(fallbackWav);
    await removeWithRetry(removeFile, fallbackWav.path, {force: true});
  } finally {
    await removeFallbackDirectory(fallbackWav);
  }
}

async function removeWithRetry(removeFile, candidate, options) {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await removeFile(candidate, options);
      return;
    } catch (error) {
      if (attempt === CLEANUP_ATTEMPTS - 1 || !isLikelyWindowsFileLock(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_DELAY_MS));
    }
  }
}

async function removeFallbackDirectory(fallbackWav) {
  try {
    await assertPrivateFallbackDirectory(fallbackWav);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  try {
    await fs.rmdir(fallbackWav.directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertPrivateFallbackDirectory({directory, tempDir, realTempDir}) {
  if (!isContainedBy(tempDir, directory)) {
    throw new Error('ASR fallback cleanup refused a path outside tempDir');
  }
  await assertUnchangedTempDir(tempDir, realTempDir);
  const [realDirectory, directoryStats] = await Promise.all([fs.realpath(directory), fs.lstat(directory)]);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory() || !isContainedBy(realTempDir, realDirectory)) {
    throw new Error('ASR fallback cleanup refused a path outside tempDir');
  }
}

async function assertUnchangedTempDir(tempDir, realTempDir) {
  if (await fs.realpath(tempDir) !== realTempDir) {
    throw new Error('ASR fallback staging refused a changed tempDir');
  }
}

function isContainedBy(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isContainedByOrEqual(parent, candidate) {
  return parent === candidate || isContainedBy(parent, candidate);
}

function isLikelyWindowsFileLock(error) {
  return error?.code === 'EBUSY' || error?.code === 'EACCES' || error?.code === 'EPERM';
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
