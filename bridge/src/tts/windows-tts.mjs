import {spawn as nodeSpawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parsePcmWav} from '../audio/wav.mjs';

const TIMEOUT_MS = 90_000;
const defaultScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/synthesize.ps1');
const defaultPowerShellPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export class WindowsTts {
  #powershellPath;
  #scriptPath;
  #tempDir;
  #spawn;
  #setTimeout;
  #clearTimeout;

  constructor({
    powershellPath = defaultPowerShellPath,
    scriptPath = defaultScriptPath,
    tempDir = tmpdir(),
    spawn = nodeSpawn,
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout
  } = {}) {
    for (const [name, value] of Object.entries({powershellPath, scriptPath, tempDir})) {
      if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
    }
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    if (typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function') throw new TypeError('timer functions must be functions');
    this.#powershellPath = powershellPath;
    this.#scriptPath = scriptPath;
    this.#tempDir = tempDir;
    this.#spawn = spawn;
    this.#setTimeout = scheduleTimeout;
    this.#clearTimeout = cancelTimeout;
  }

  async synthesize(text) {
    if (typeof text !== 'string' || text.trim() === '') throw new TypeError('text must be a non-empty string');

    const directory = await mkdtemp(path.join(this.#tempDir, 'xiaoli-tts-'));
    const wavPath = path.join(directory, 'speech.wav');
    try {
      await this.#runSynthesis(text, wavPath);
      return parsePcmWav(await readFile(wavPath)).pcm;
    } finally {
      await rm(wavPath, {force: true});
      await rm(directory, {recursive: true, force: true});
    }
  }

  #runSynthesis(text, wavPath) {
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let settled = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.#clearTimeout(timer);
        child?.removeListener('error', onError);
        child?.removeListener('close', onClose);
        callback();
      };

      const stopChild = () => {
        try {
          child?.kill();
        } catch {
          // The caller still receives the bounded error if process cleanup fails.
        }
      };

      const onError = () => finish(() => reject(new Error('Windows TTS process could not start')));
      const onClose = (code) => {
        if (code === 0) finish(resolve);
        else finish(() => reject(new Error('Windows TTS process failed')));
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
      timer = this.#setTimeout(() => {
        stopChild();
        finish(() => reject(new Error('Windows TTS synthesis timed out')));
      }, TIMEOUT_MS);
      timer.unref?.();
    });
  }
}
