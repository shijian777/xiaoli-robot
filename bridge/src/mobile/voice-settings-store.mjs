import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = 'mobile-voice-settings.json';
const MAX_FILE_BYTES = 4_096;
const SETTING_KEYS = ['pitch', 'speed', 'voice', 'volume'];
const VOICE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(message = 'invalid voice settings') {
  return new Error(message);
}

function canonicalSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid();
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== SETTING_KEYS.length ||
      keys.some((key, index) => key !== SETTING_KEYS[index])) {
    throw invalid();
  }
  if (typeof value.voice !== 'string' || !VOICE_PATTERN.test(value.voice)) {
    throw invalid('invalid voice settings voice');
  }
  for (const key of ['speed', 'volume', 'pitch']) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100) {
      throw invalid(`invalid voice settings ${key}`);
    }
  }
  return {
    voice: value.voice,
    speed: value.speed,
    volume: value.volume,
    pitch: value.pitch
  };
}

async function bestEffortDirectorySync(fileSystem, directory) {
  let handle;
  try {
    handle = await fileSystem.open(directory, 'r');
    await handle.sync();
  } catch {
    // The rename already committed the new value. Directory fsync is not
    // available on every supported platform, so it must not make runtime and
    // persisted settings disagree after the commit point.
  } finally {
    await handle?.close().catch(() => {});
  }
}
export class VoiceSettingsStore {
  #fs;
  #stateDir;
  #statePath;

  constructor({stateDir, fileSystem = fs} = {}) {
    if (typeof stateDir !== 'string' || stateDir.trim() === '') {
      throw new TypeError('stateDir must be a non-empty string');
    }
    this.#fs = fileSystem;
    this.#stateDir = path.resolve(stateDir);
    this.#statePath = path.join(this.#stateDir, FILE_NAME);
  }

  async load() {
    let stat;
    try {
      stat = await this.#fs.lstat(this.#statePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      throw invalid('invalid voice settings file');
    }

    let envelope;
    try {
      envelope = JSON.parse(await this.#fs.readFile(this.#statePath, 'utf8'));
    } catch (error) {
      throw invalid(`invalid voice settings file: ${error.message}`);
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope) ||
        Object.keys(envelope).sort().join(',') !== 'settings,version' ||
        envelope.version !== 1) {
      throw invalid('invalid voice settings envelope');
    }
    return canonicalSettings(envelope.settings);
  }

  async save(settings) {
    const canonical = canonicalSettings(settings);
    const payload = `${JSON.stringify({version: 1, settings: canonical})}\n`;
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) throw invalid();

    await this.#fs.mkdir(this.#stateDir, {recursive: true});
    const partPath = path.join(
      this.#stateDir,
      `mobile-voice-settings.${randomUUID()}.part`
    );
    let handle;
    let renamed = false;
    try {
      handle = await this.#fs.open(partPath, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#fs.rename(partPath, this.#statePath);
      renamed = true;
      await bestEffortDirectorySync(this.#fs, this.#stateDir);
    } finally {
      await handle?.close().catch(() => {});
      if (!renamed) await this.#fs.rm(partPath, {force: true}).catch(() => {});
    }
    return {...canonical};
  }
}
