import {spawn as nodeSpawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 90_000;
const TERMINATION_GRACE_MS = 1_000;
const FORCE_TERMINATION_GRACE_MS = 1_000;

export class EspeakTts {
  #espeakPath;
  #ffmpegPath;
  #tempDir;
  #spawn;
  #fs;
  #setTimeout;
  #clearTimeout;

  constructor({
    espeakPath = 'espeak-ng',
    ffmpegPath = 'ffmpeg',
    tempDir = tmpdir(),
    spawn = nodeSpawn,
    fs = {mkdtemp, writeFile, rm},
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout
  } = {}) {
    for (const [name, value] of Object.entries({espeakPath, ffmpegPath, tempDir})) {
      if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
    }
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    if (!fs || typeof fs.mkdtemp !== 'function' || typeof fs.writeFile !== 'function' || typeof fs.rm !== 'function') {
      throw new TypeError('fs must provide mkdtemp, writeFile, and rm functions');
    }
    if (typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function') throw new TypeError('timer functions must be functions');
    this.#espeakPath = espeakPath;
    this.#ffmpegPath = ffmpegPath;
    this.#tempDir = tempDir;
    this.#spawn = spawn;
    this.#fs = fs;
    this.#setTimeout = scheduleTimeout;
    this.#clearTimeout = cancelTimeout;
  }

  async synthesize(text, {signal} = {}) {
    if (typeof text !== 'string' || text.trim() === '') throw new TypeError('text must be a non-empty string');
    signal?.throwIfAborted();
    const directory = await this.#fs.mkdtemp(path.join(this.#tempDir, 'xiaoli-espeak-tts-'));
    const wavPath = path.join(directory, 'speech.wav');
    let cleanupPromise;
    let cleanupDeferred = false;
    const cleanup = () => cleanupPromise ??= Promise.allSettled([
      this.#fs.rm(wavPath, {force: true}),
      this.#fs.rm(directory, {recursive: true, force: true})
    ]);
    try {
      const wav = await this.#run(this.#espeakPath, ['-v', 'cmn', '--stdin', '--stdout'], {
        input: text, signal, cleanupAfterClose: cleanup
      });
      await this.#fs.writeFile(wavPath, wav);
      return await this.#run(this.#ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-i', wavPath,
        '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1'
      ], {signal, cleanupAfterClose: cleanup});
    } catch (error) {
      cleanupDeferred = error instanceof DeferredCleanupTimeoutError || error instanceof DeferredCleanupAbortError;
      throw error;
    } finally {
      if (!cleanupDeferred) await cleanup();
    }
  }

  #run(command, args, {input, signal, cleanupAfterClose} = {}) {
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let terminationTimer;
      let forceTerminationTimer;
      let settled = false;
      let terminationReason;
      const output = [];
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.#clearTimeout(timer);
        if (terminationTimer !== undefined) this.#clearTimeout(terminationTimer);
        if (forceTerminationTimer !== undefined) this.#clearTimeout(forceTerminationTimer);
        child?.removeListener('error', onError);
        child?.removeListener('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const stop = (signalName) => {
        child?.on('error', () => {});
        try { child?.kill(signalName); } catch { /* The bounded error below remains authoritative. */ }
      };
      const onError = () => {
        if (!terminationReason) finish(() => reject(new Error('Espeak TTS process could not start')));
      };
      const onClose = (code) => {
        if (terminationReason === 'abort') finish(() => reject(abortError()));
        else if (terminationReason === 'timeout') finish(() => reject(new Error('Espeak TTS synthesis timed out')));
        else if (code === 0) finish(() => resolve(Buffer.concat(output)));
        else finish(() => reject(new Error('Espeak TTS process failed')));
      };
      const onAbort = () => {
        beginTermination('abort');
      };
      const onDeferredClose = () => { void cleanupAfterClose?.().catch(() => {}); };
      const beginTermination = (reason) => {
        if (settled || terminationReason) return;
        terminationReason = reason;
        stop();
        terminationTimer = this.#setTimeout(() => {
          if (settled) return;
          stop('SIGKILL');
          forceTerminationTimer = this.#setTimeout(() => {
            if (settled) return;
            child?.once('close', onDeferredClose);
            finish(() => reject(reason === 'abort'
              ? new DeferredCleanupAbortError()
              : new DeferredCleanupTimeoutError()));
          }, FORCE_TERMINATION_GRACE_MS);
          forceTerminationTimer.unref?.();
        }, TERMINATION_GRACE_MS);
        terminationTimer.unref?.();
      };
      try {
        child = this.#spawn(command, args, {shell: false, windowsHide: true});
        child.stdout?.on('data', (chunk) => output.push(Buffer.from(chunk)));
        child.once('error', onError);
        child.once('close', onClose);
        signal?.addEventListener('abort', onAbort, {once: true});
        if (signal?.aborted) beginTermination('abort');
        else {
          timer = this.#setTimeout(() => {
            beginTermination('timeout');
          }, TIMEOUT_MS);
          timer.unref?.();
        }
        if (input !== undefined && !terminationReason) {
          child.stdin?.write(input);
          child.stdin?.end();
        }
      } catch {
        finish(() => reject(new Error('Espeak TTS process could not start')));
      }
    });
  }
}

class DeferredCleanupTimeoutError extends Error {
  constructor() {
    super('Espeak TTS synthesis timed out');
  }
}

class DeferredCleanupAbortError extends DOMException {
  constructor() {
    super('Espeak TTS synthesis aborted', 'AbortError');
  }
}

function abortError() {
  return new DOMException('Espeak TTS synthesis aborted', 'AbortError');
}
