import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const STATE_FILE = 'bridge-state.json';
const STATE_PART_PATTERN = /^bridge-state\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/i;
export const MAX_PERSISTED_STATE_BYTES = 64 * 1024 * 1024;

export class AtomicStateCommitError extends Error {
  constructor(cause, commitPhase) {
    super(`Bridge persistent state commit failed during ${commitPhase}`, {cause});
    this.name = 'AtomicStateCommitError';
    this.code = cause?.code;
    this.commitPhase = commitPhase;
    this.stateMayBeVisible = commitPhase === 'post-rename';
  }
}

export class AtomicJsonStateStore {
  #stateDir;
  #statePath;
  #fs;
  #tail = Promise.resolve();

  constructor({stateDir, fileSystem = fs} = {}) {
    if (typeof stateDir !== 'string' || stateDir.trim() === '') {
      throw new TypeError('stateDir must be a non-empty string');
    }
    for (const method of ['lstat', 'mkdir', 'open', 'rename', 'readFile', 'readdir', 'rm']) {
      if (typeof fileSystem?.[method] !== 'function') {
        throw new TypeError(`fileSystem must provide ${method}()`);
      }
    }
    this.#stateDir = path.resolve(stateDir);
    this.#statePath = path.join(this.#stateDir, STATE_FILE);
    this.#fs = fileSystem;
  }

  get stateDir() {
    return this.#stateDir;
  }

  async load() {
    await this.#tail.catch(() => {});
    try {
      const stats = await this.#fs.lstat(this.#statePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('Bridge persistent state must be a regular file');
      }
      if (stats.size > MAX_PERSISTED_STATE_BYTES) {
        throw new Error(`Bridge persistent state exceeds the ${MAX_PERSISTED_STATE_BYTES}-byte size limit`);
      }
      const bytes = await this.#fs.readFile(this.#statePath);
      if (bytes.byteLength > MAX_PERSISTED_STATE_BYTES) {
        throw new Error(`Bridge persistent state exceeds the ${MAX_PERSISTED_STATE_BYTES}-byte size limit`);
      }
      const state = JSON.parse(bytes.toString('utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error('Bridge persistent state must be a JSON object');
      }
      return state;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  commit(state) {
    let serialized;
    try {
      serialized = `${JSON.stringify(state)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_PERSISTED_STATE_BYTES) {
        throw new Error(`Bridge persistent state exceeds the ${MAX_PERSISTED_STATE_BYTES}-byte size limit`);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.#tail.catch(() => {}).then(() => this.#commitSerialized(serialized));
    this.#tail = operation;
    return operation;
  }

  async cleanupParts() {
    await this.#fs.mkdir(this.#stateDir, {recursive: true});
    const entries = await this.#fs.readdir(this.#stateDir, {withFileTypes: true});
    await Promise.all(entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && STATE_PART_PATTERN.test(entry.name))
      .map((entry) => this.#fs.rm(path.join(this.#stateDir, entry.name), {force: true})));
  }

  async #commitSerialized(serialized) {
    await this.#fs.mkdir(this.#stateDir, {recursive: true});
    const partPath = path.join(this.#stateDir, `bridge-state.${randomUUID()}.part`);
    let handle;
    let renamed = false;
    try {
      handle = await this.#fs.open(partPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#fs.rename(partPath, this.#statePath);
      renamed = true;
      await syncDirectory(this.#fs, this.#stateDir);
    } catch (error) {
      await handle?.close().catch(() => {});
      await this.#fs.rm(partPath, {force: true}).catch(() => {});
      throw new AtomicStateCommitError(
        error, renamed ? 'post-rename' : 'pre-rename');
    }
  }
}

export async function syncDirectory(fileSystem, directory) {
  let handle;
  try {
    handle = await fileSystem.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' || !['EACCES', 'EISDIR', 'EINVAL', 'EPERM'].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}
