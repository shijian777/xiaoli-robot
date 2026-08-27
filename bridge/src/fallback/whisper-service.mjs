import {spawn as nodeSpawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const TIMEOUT_MS = 180_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const defaultScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/transcribe.py');

export class WhisperService {
  #pythonBin;
  #whisperModel;
  #scriptPath;
  #spawn;

  constructor({pythonBin = 'python', whisperModel = 'small', scriptPath = defaultScriptPath, spawn = nodeSpawn} = {}) {
    if (typeof pythonBin !== 'string' || pythonBin.trim() === '') throw new TypeError('pythonBin must be a non-empty string');
    if (typeof whisperModel !== 'string' || whisperModel.trim() === '') throw new TypeError('whisperModel must be a non-empty string');
    if (typeof scriptPath !== 'string' || scriptPath.trim() === '') throw new TypeError('scriptPath must be a non-empty string');
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    this.#pythonBin = pythonBin;
    this.#whisperModel = whisperModel;
    this.#scriptPath = scriptPath;
    this.#spawn = spawn;
  }

  async transcribe(wavPath) {
    if (typeof wavPath !== 'string' || wavPath.trim() === '') throw new TypeError('wavPath must be a non-empty string');
    return new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      let stdoutBytes = 0;
      let settled = false;
      let timedOut = false;
      let exceededStdout = false;
      let timeout;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      try {
        child = this.#spawn(this.#pythonBin, [
          this.#scriptPath,
          '--model', this.#whisperModel,
          '--input', wavPath
        ], {shell: false});
      } catch {
        finish(() => reject(new Error('Whisper transcription process could not start')));
        return;
      }

      timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, TIMEOUT_MS);
      timeout.unref?.();

      child.stdout.on('data', (chunk) => {
        if (settled || exceededStdout) return;
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          exceededStdout = true;
          child.kill();
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.once('error', () => finish(() => reject(new Error('Whisper transcription process failed'))));
      child.once('close', (code) => {
        if (timedOut) return finish(() => reject(new Error('Whisper transcription timed out')));
        if (exceededStdout) return finish(() => reject(new Error('Whisper transcription output exceeded 1 MiB')));
        if (code !== 0) return finish(() => reject(new Error('Whisper transcription process failed')));
        try {
          const transcript = parseTranscript(stdout);
          finish(() => resolve(transcript));
        } catch (error) {
          finish(() => reject(error));
        }
      });
    });
  }
}

function parseTranscript(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || lines[0] === '') {
    throw new Error('Whisper transcription must emit one JSON line');
  }
  let result;
  try {
    result = JSON.parse(lines[0]);
  } catch {
    throw new Error('Whisper transcription must emit valid JSON');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.transcript !== 'string') {
    throw new Error('Whisper transcription must emit a transcript');
  }
  const transcript = result.transcript.trim();
  if (transcript === '') throw new Error('Whisper transcription returned an empty transcript');
  return transcript;
}
