import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {AtomicJsonStateStore} from '../src/persistence/atomic-json-state-store.mjs';

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-state-store-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('atomically fsyncs the state file before rename and then fsyncs its parent directory', async () => {
  await withDirectory(async (stateDir) => {
    const events = [];
    const fileSystem = {
      ...realFs,
      async open(candidate, flags, mode) {
        const handle = await realFs.open(candidate, flags, mode);
        const directoryHandle = path.resolve(candidate) === path.resolve(stateDir);
        return {
          async writeFile(...args) {
            events.push('file.write');
            return handle.writeFile(...args);
          },
          async sync() {
            events.push(directoryHandle ? 'directory.sync' : 'file.sync');
            return handle.sync();
          },
          async close() {
            events.push(directoryHandle ? 'directory.close' : 'file.close');
            return handle.close();
          }
        };
      },
      async rename(...args) {
        events.push('rename');
        return realFs.rename(...args);
      }
    };
    const store = new AtomicJsonStateStore({stateDir, fileSystem});

    await store.commit({version: 1, value: 'durable'});

    assert.deepEqual(events, [
      'file.write', 'file.sync', 'file.close', 'rename',
      'directory.sync', 'directory.close'
    ]);
    assert.deepEqual(await store.load(), {version: 1, value: 'durable'});
    assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, 'bridge-state.json'), 'utf8')),
      {version: 1, value: 'durable'});
  });
});

test('marks a directory fsync failure after rename as an ambiguous post-rename commit', async () => {
  await withDirectory(async (stateDir) => {
    let failDirectorySync = false;
    const fileSystem = {
      ...realFs,
      async open(candidate, flags, mode) {
        const handle = await realFs.open(candidate, flags, mode);
        if (path.resolve(candidate) !== path.resolve(stateDir)) return handle;
        return {
          async sync() {
            if (failDirectorySync) {
              throw Object.assign(new Error('injected directory fsync failure'), {code: 'EIO'});
            }
            return handle.sync();
          },
          close: (...args) => handle.close(...args)
        };
      }
    };
    const store = new AtomicJsonStateStore({stateDir, fileSystem});
    await store.commit({version: 1, value: 'old'});
    failDirectorySync = true;

    let failure;
    try {
      await store.commit({version: 1, value: 'new'});
    } catch (error) {
      failure = error;
    }

    assert.equal(failure?.commitPhase, 'post-rename');
    assert.equal(failure?.stateMayBeVisible, true);
    assert.equal(failure?.code, 'EIO');
    assert.deepEqual(await store.load(), {version: 1, value: 'new'});
  });
});

test('serializes concurrent commits so the last requested snapshot wins', async () => {
  await withDirectory(async (stateDir) => {
    const firstRename = Promise.withResolvers();
    const releaseFirst = Promise.withResolvers();
    let renames = 0;
    const fileSystem = {
      ...realFs,
      async rename(...args) {
        renames += 1;
        if (renames === 1) {
          firstRename.resolve();
          await releaseFirst.promise;
        }
        return realFs.rename(...args);
      }
    };
    const store = new AtomicJsonStateStore({stateDir, fileSystem});
    const first = store.commit({version: 1, sequence: 1});
    await firstRename.promise;
    const second = store.commit({version: 1, sequence: 2});
    releaseFirst.resolve();
    await Promise.all([first, second]);

    assert.deepEqual(await store.load(), {version: 1, sequence: 2});
  });
});

test('removes only strict regular state part files and leaves unrelated files untouched', async (t) => {
  await withDirectory(async (stateDir) => {
    const strictPart = path.join(stateDir, 'bridge-state.123e4567-e89b-12d3-a456-426614174000.part');
    const unrelatedPart = path.join(stateDir, 'notes.part');
    const nearMatch = path.join(stateDir, 'bridge-state.not-a-uuid.part');
    await Promise.all([
      writeFile(strictPart, 'stale'),
      writeFile(unrelatedPart, 'keep'),
      writeFile(nearMatch, 'keep')
    ]);
    const store = new AtomicJsonStateStore({stateDir});

    await store.cleanupParts();

    assert.deepEqual((await readdir(stateDir)).sort(), ['bridge-state.not-a-uuid.part', 'notes.part']);

    const target = path.join(stateDir, 'target.txt');
    const link = path.join(stateDir, 'bridge-state.123e4567-e89b-12d3-a456-426614174001.part');
    await writeFile(target, 'target');
    try {
      await realFs.symlink(target, link, 'file');
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.diagnostic('symlink creation is unavailable for this Windows account');
        return;
      }
      throw error;
    }
    await store.cleanupParts();
    assert.equal(await readFile(target, 'utf8'), 'target');
    assert.ok((await readdir(stateDir)).includes(path.basename(link)));
  });
});

test('rejects an oversized state file before reading or parsing its contents', async () => {
  await withDirectory(async (stateDir) => {
    let readCalls = 0;
    const statePath = path.join(stateDir, 'bridge-state.json');
    const fileSystem = {
      ...realFs,
      async lstat(candidate) {
        if (path.resolve(candidate) === path.resolve(statePath)) {
          return {
            size: 1024 * 1024 * 1024,
            isFile: () => true,
            isSymbolicLink: () => false
          };
        }
        return realFs.lstat(candidate);
      },
      async readFile() {
        readCalls += 1;
        throw new Error('oversized state must not be read');
      }
    };
    const store = new AtomicJsonStateStore({stateDir, fileSystem});

    await assert.rejects(() => store.load(), /state.*(?:large|limit|size)/i);
    assert.equal(readCalls, 0);
  });
});
