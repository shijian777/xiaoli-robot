import {spawn as nodeSpawn} from 'node:child_process';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {fileURLToPath} from 'node:url';

const TIMEOUT_MS = 180_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const defaultScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/transcribe.py');

export class WhisperService {
  #pythonBin;
  #scriptPath;
  #spawn;
  #setTimeout;
  #clearTimeout;

  constructor({pythonBin = 'python', scriptPath = defaultScriptPath, spawn = nodeSpawn, setTimeout: scheduleTimeout = setTimeout, clearTimeout: cancelTimeout = clearTimeout} = {}) {
    if (typeof pythonBin !== 'string' || pythonBin.trim() === '') throw new TypeError('pythonBin must be a non-empty string');
    if (typeof scriptPath !== 'string' || scriptPath.trim() === '') throw new TypeError('scriptPath must be a non-empty string');
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    if (typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function') throw new TypeError('timer functions must be functions');
    this.#pythonBin = pythonBin;
    this.#scriptPath = scriptPath;
    this.#spawn = spawn;
    this.#setTimeout = scheduleTimeout;
    this.#clearTimeout = cancelTimeout;
  }

  async transcribe(wavPath, {signal} = {}) {
    if (typeof wavPath !== 'string' || wavPath.trim() === '') throw new TypeError('wavPath must be a non-empty string');
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      const decoder = new StringDecoder('utf8');
      let stdoutBytes = 0;
      let settled = false;
      let timeout;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) this.#clearTimeout(timeout);
        child?.stdout?.removeListener('data', onStdout);
        child?.removeListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };

      const stopChild = () => {
        try {
          child.kill();
        } catch {
          // The caller still receives the bound error even if process cleanup fails.
        }
      };

      const onStdout = (chunk) => {
        if (settled) return;
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          stopChild();
          finish(() => reject(new Error('Whisper transcription output exceeded 1 MiB')));
          return;
        }
        stdout += decoder.write(chunk);
      };

      const onError = () => {
        if (!settled) finish(() => reject(new Error('Whisper transcription process failed')));
      };

      const onAbort = () => {
        stopChild();
        finish(() => reject(abortError()));
      };

      const onClose = (code) => {
        if (settled) return;
        if (code !== 0) return finish(() => reject(new Error('Whisper transcription process failed')));
        try {
          stdout += decoder.end();
          const transcript = parseTranscript(stdout);
          finish(() => resolve(transcript));
        } catch (error) {
          finish(() => reject(error));
        }
      };

      try {
        child = this.#spawn(this.#pythonBin, [
          this.#scriptPath,
          '--model', 'small',
          '--input', wavPath
        ], {shell: false});
      } catch {
        finish(() => reject(new Error('Whisper transcription process could not start')));
        return;
      }

      child.stdout.on('data', onStdout);
      child.once('error', onError);
      child.once('close', onClose);
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) {
        onAbort();
        return;
      }
      timeout = this.#setTimeout(() => {
        stopChild();
        finish(() => reject(new Error('Whisper transcription timed out')));
      }, TIMEOUT_MS);
      timeout.unref?.();
    });
  }
}

function abortError() {
  const error = new Error('Whisper transcription aborted');
  error.name = 'AbortError';
  return error;
}

function parseTranscript(stdout) {
  // The fallback CLI contract is exactly one JSON record, optionally followed
  // by its single line terminator. Do not trim the whole stream: that would
  // silently accept blank lines or other accidental output around the record.
  const line = /^(.*?)(?:\r?\n)?$/.exec(stdout)?.[1];
  if (line === undefined || line.trim() === '') {
    throw new Error('Whisper transcription must emit one JSON line');
  }
  let result;
  try {
    result = JSON.parse(line);
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
