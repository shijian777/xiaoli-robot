import {spawn as nodeSpawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parsePcmWav} from '../audio/wav.mjs';

const TIMEOUT_MS = 90_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCE_TERMINATION_GRACE_MS = 1_000;
const CLEANUP_RETRY_DELAY_MS = 50;
const CLEANUP_ATTEMPTS = 3;
const defaultScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/synthesize.ps1');
const defaultPowerShellPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export class WindowsTts {
  #powershellPath;
  #scriptPath;
  #tempDir;
  #spawn;
  #fs;
  #setTimeout;
  #clearTimeout;

  constructor({
    powershellPath = defaultPowerShellPath,
    scriptPath = defaultScriptPath,
    tempDir = tmpdir(),
    spawn = nodeSpawn,
    fs = {mkdtemp, readFile, rm},
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout
  } = {}) {
    for (const [name, value] of Object.entries({powershellPath, scriptPath, tempDir})) {
      if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
    }
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    if (!fs || typeof fs.mkdtemp !== 'function' || typeof fs.readFile !== 'function' || typeof fs.rm !== 'function') {
      throw new TypeError('fs must provide mkdtemp, readFile, and rm functions');
    }
    if (typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function') throw new TypeError('timer functions must be functions');
    this.#powershellPath = powershellPath;
    this.#scriptPath = scriptPath;
    this.#tempDir = tempDir;
    this.#spawn = spawn;
    this.#fs = fs;
    this.#setTimeout = scheduleTimeout;
    this.#clearTimeout = cancelTimeout;
  }

  async synthesize(text, {signal} = {}) {
    if (typeof text !== 'string' || text.trim() === '') throw new TypeError('text must be a non-empty string');
    signal?.throwIfAborted();

    const directory = await this.#fs.mkdtemp(path.join(this.#tempDir, 'xiaoli-tts-'));
    const wavPath = path.join(directory, 'speech.wav');
    let cleanupPromise;
    let cleanupDeferred = false;
    const cleanup = () => cleanupPromise ??= this.#cleanup(directory, wavPath);
    try {
      signal?.throwIfAborted();
      await this.#runSynthesis(text, wavPath, cleanup, signal);
      return parsePcmWav(await this.#fs.readFile(wavPath)).pcm;
    } catch (error) {
      cleanupDeferred = error instanceof DeferredCleanupTimeoutError;
      throw error;
    } finally {
      if (!cleanupDeferred) await cleanup();
    }
  }

  async #cleanup(directory, wavPath) {
    await Promise.allSettled([
      this.#removeWithRetry(wavPath, {force: true}),
      this.#removeWithRetry(directory, {recursive: true, force: true})
    ]);
  }

  async #removeWithRetry(candidate, options) {
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await this.#fs.rm(candidate, options);
        return;
      } catch (error) {
        if (attempt === CLEANUP_ATTEMPTS - 1 || !isLikelyWindowsFileLock(error)) return;
        await this.#delay(CLEANUP_RETRY_DELAY_MS);
      }
    }
  }

  #delay(milliseconds) {
    return new Promise((resolve) => {
      const timer = this.#setTimeout(resolve, milliseconds);
      timer.unref?.();
    });
  }

  #runSynthesis(text, wavPath, cleanupAfterClose, signal) {
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let terminationTimer;
      let settled = false;
      let timingOut = false;
      let cancelled = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.#clearTimeout(timer);
        if (terminationTimer !== undefined) this.#clearTimeout(terminationTimer);
        if (!timingOut) child?.removeListener('error', onError);
        child?.removeListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };

      const stopChild = () => {
        try {
          child?.kill();
        } catch {
          // The caller still receives the bounded error if process cleanup fails.
        }
      };

      const onError = () => {
        if (!timingOut) finish(() => reject(new Error('Windows TTS process could not start')));
      };
      const onClose = (code) => {
        if (cancelled) finish(() => reject(abortError()));
        else if (timingOut) finish(() => reject(new Error('Windows TTS synthesis timed out')));
        else if (code === 0) finish(resolve);
        else finish(() => reject(new Error('Windows TTS process failed')));
      };
      const onAbort = () => {
        if (settled || timingOut) return;
        cancelled = true;
        timingOut = true;
        child.on('error', () => {});
        stopChild();
        this.#forceTerminate(child?.pid);
      };
      const onDeferredClose = () => {
        void cleanupAfterClose().catch(() => {});
      };

      try {
        child = this.#spawn(this.#powershellPath, [
          '-Sta',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', this.#scriptPath,
          '-Text', text,
          '-OutputPath', wavPath
        ], {shell: false, windowsHide: true});
      } catch {
        finish(() => reject(new Error('Windows TTS process could not start')));
        return;
      }

      child.once('error', onError);
      child.once('close', onClose);
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) onAbort();
      timer = this.#setTimeout(() => {
        if (settled || timingOut) return;
        timingOut = true;
        child.on('error', () => {});
        stopChild();
        terminationTimer = this.#setTimeout(() => {
          if (settled) return;
          this.#forceTerminate(child?.pid);
          terminationTimer = this.#setTimeout(() => {
            if (settled) return;
            child?.once('close', onDeferredClose);
            finish(() => reject(new DeferredCleanupTimeoutError()));
          }, FORCE_TERMINATION_GRACE_MS);
          terminationTimer.unref?.();
        }, TERMINATION_GRACE_MS);
        terminationTimer.unref?.();
      }, TIMEOUT_MS);
      timer.unref?.();
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

class DeferredCleanupTimeoutError extends Error {
  constructor() {
    super('Windows TTS synthesis timed out');
  }
}

function abortError() {
  const error = new Error('Windows TTS synthesis aborted');
  error.name = 'AbortError';
  return error;
}

function isLikelyWindowsFileLock(error) {
  return error?.code === 'EBUSY' || error?.code === 'EACCES' || error?.code === 'EPERM';
}
