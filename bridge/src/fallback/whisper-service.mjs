import {spawn as nodeSpawn} from 'node:child_process';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {fileURLToPath} from 'node:url';

const TIMEOUT_MS = 180_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const FORCE_TERMINATION_GRACE_MS = 1_000;
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

  async transcribe(wavPath, {signal, cleanupAfterClose} = {}) {
    if (typeof wavPath !== 'string' || wavPath.trim() === '') throw new TypeError('wavPath must be a non-empty string');
    if (cleanupAfterClose !== undefined && typeof cleanupAfterClose !== 'function') {
      throw new TypeError('cleanupAfterClose must be a function');
    }
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      const decoder = new StringDecoder('utf8');
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timeout;
      let terminationTimer;
      let terminatingError;

      const finish = (callback, {keepDrains = false} = {}) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) this.#clearTimeout(timeout);
        if (terminationTimer !== undefined) this.#clearTimeout(terminationTimer);
        if (!keepDrains) {
          child?.stdout?.removeListener('data', onStdout);
          child?.stderr?.removeListener('data', onStderr);
        }
        child?.removeListener('error', onError);
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
        if (settled || terminatingError) return;
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          beginTermination(new Error('Whisper transcription output exceeded 1 MiB'));
          return;
        }
        stdout += decoder.write(chunk);
      };

      const onStderr = (chunk) => {
        if (settled || terminatingError) return;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_STDERR_BYTES) {
          beginTermination(new Error('Whisper transcription diagnostic output exceeded its limit'));
        }
      };

      const onError = () => {
        if (!settled && !terminatingError) finish(() => reject(new Error('Whisper transcription process failed')));
      };

      const onAbort = () => {
        beginTermination(abortError());
      };

      const onClose = (code) => {
        if (settled) return;
        if (terminatingError) return finish(() => reject(terminatingError));
        if (code !== 0) return finish(() => reject(new Error('Whisper transcription process failed')));
        try {
          stdout += decoder.end();
          const transcript = parseTranscript(stdout);
          finish(() => resolve(transcript));
        } catch (error) {
          finish(() => reject(error));
        }
      };

      const onDeferredClose = () => {
        child?.stdout?.removeListener('data', onStdout);
        child?.stderr?.removeListener('data', onStderr);
        if (!cleanupAfterClose) return;
        void Promise.resolve().then(cleanupAfterClose).catch(() => {});
      };

      const beginTermination = (error) => {
        if (settled || terminatingError) return;
        terminatingError = error;
        if (timeout !== undefined) {
          this.#clearTimeout(timeout);
          timeout = undefined;
        }
        stopChild();
        terminationTimer = this.#setTimeout(() => {
          if (settled) return;
          this.#forceTerminate(child?.pid);
          terminationTimer = this.#setTimeout(() => {
            if (settled) return;
            markCleanupDeferred(terminatingError);
            child?.once('close', onDeferredClose);
            finish(() => reject(terminatingError), {keepDrains: true});
          }, FORCE_TERMINATION_GRACE_MS);
          terminationTimer.unref?.();
        }, TERMINATION_GRACE_MS);
        terminationTimer.unref?.();
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
      child.stderr.on('data', onStderr);
      child.on('error', () => {});
      child.once('error', onError);
      child.once('close', onClose);
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) {
        onAbort();
      }
      if (!terminatingError) {
        timeout = this.#setTimeout(() => {
          beginTermination(new Error('Whisper transcription timed out'));
        }, TIMEOUT_MS);
        timeout.unref?.();
      }
    });
  }

  #forceTerminate(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      const terminator = this.#spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {shell: false, windowsHide: true});
      terminator?.on?.('error', () => {});
      terminator?.on?.('close', () => {});
    } catch {
      // The second close grace still bounds the caller if taskkill cannot start.
    }
  }
}

function abortError() {
  const error = new Error('Whisper transcription aborted');
  error.name = 'AbortError';
  return error;
}

function markCleanupDeferred(error) {
  Object.defineProperty(error, 'cleanupDeferred', {value: true, enumerable: false});
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
