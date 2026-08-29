import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

let storeModule;
try {
  storeModule = await import('../src/mobile/voice-settings-store.mjs');
} catch {
  storeModule = {};
}

const settings = {voice: 'x4_xiaoyan', speed: 50, volume: 55, pitch: 48};

async function withDirectory(run) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-mobile-settings-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, {recursive: true, force: true});
  }
}

function createStore(stateDir) {
  assert.equal(typeof storeModule.VoiceSettingsStore, 'function', 'VoiceSettingsStore must be implemented');
  return new storeModule.VoiceSettingsStore({stateDir});
}

test('VoiceSettingsStore returns null before first save and round-trips one canonical object', async () => {
  await withDirectory(async (stateDir) => {
    const store = createStore(stateDir);
    assert.equal(await store.load(), null);
    await store.save(settings);
    assert.deepEqual(await store.load(), settings);
    assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, 'mobile-voice-settings.json'), 'utf8')), {
      version: 1,
      settings
    });
  });
});

test('VoiceSettingsStore rejects malformed, incomplete and oversized persisted state', async () => {
  await withDirectory(async (stateDir) => {
    const store = createStore(stateDir);
    const target = path.join(stateDir, 'mobile-voice-settings.json');
    for (const value of [
      '{',
      JSON.stringify({version: 1, settings: {...settings, speed: 101}}),
      JSON.stringify({version: 1, settings: {...settings, extra: true}}),
      'x'.repeat(5_000)
    ]) {
      await writeFile(target, value);
      await assert.rejects(() => store.load(), /voice settings/i);
    }
  });
});

test('VoiceSettingsStore validates before replacing the previous good state', async () => {
  await withDirectory(async (stateDir) => {
    const store = createStore(stateDir);
    await store.save(settings);
    for (const invalid of [
      {...settings, voice: '../bad'},
      {...settings, speed: 1.5},
      {...settings, pitch: -1},
      {...settings, volume: 101}
    ]) {
      await assert.rejects(() => store.save(invalid), /voice settings/i);
      assert.deepEqual(await store.load(), settings);
    }
  });
});
