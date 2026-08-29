import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

let runtimeModule;
try {
  runtimeModule = await import('../src/mobile/mobile-runtime.mjs');
} catch {
  runtimeModule = {};
}

const saved = {voice: 'x4_yezi', speed: 45, volume: 60, pitch: 52};

test('mobile runtime remains disabled without an admin token', async () => {
  assert.equal(typeof runtimeModule.createMobileRuntime, 'function',
    'createMobileRuntime must be implemented');
  const runtime = await runtimeModule.createMobileRuntime({adminToken: null});
  assert.deepEqual(runtime, {enabled: false, handler: null});
});

test('mobile runtime restores voice settings before exposing its composed handler', async () => {
  assert.equal(typeof runtimeModule.createMobileRuntime, 'function',
    'createMobileRuntime must be implemented');
  const root = await mkdtemp(path.join(tmpdir(), 'xiaoli-mobile-runtime-'));
  const publicDir = path.join(root, 'public');
  const apkPath = path.join(root, 'app.apk');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html>');
  await writeFile(path.join(publicDir, 'styles.css'), 'body{}');
  await writeFile(path.join(publicDir, 'app.js'), '');
  await writeFile(apkPath, 'apk');
  const events = [];
  let current = {voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50};
  const voiceSettingsStore = {
    async load() { events.push('load'); return saved; },
    async save(value) { events.push(['save', value]); }
  };
  const ttsService = {
    getVoiceSettings() { return {...current}; },
    updateVoiceSettings(value) { events.push(['apply', value]); current = {...value}; return current; }
  };
  const controlPlane = {
    mobileSnapshot() { return {devices: []}; },
    async requestMobileMediation() { throw new Error('unused'); }
  };
  try {
    const runtime = await runtimeModule.createMobileRuntime({
      adminToken: 'mobile-admin-0123456789abcdef-strong',
      controlPlane,
      ttsService,
      voiceSettingsStore,
      publicDir,
      apkPath
    });
    assert.equal(runtime.enabled, true);
    assert.equal(typeof runtime.handler, 'function');
    assert.deepEqual(events, ['load', ['apply', saved]]);
    assert.deepEqual(ttsService.getVoiceSettings(), saved);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('mobile runtime enables status and mediation without constructing a voice store for fixed TTS', async () => {
  assert.equal(typeof runtimeModule.createMobileRuntime, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'xiaoli-mobile-runtime-fixed-'));
  const publicDir = path.join(root, 'public');
  const apkPath = path.join(root, 'app.apk');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html>');
  await writeFile(path.join(publicDir, 'styles.css'), 'body{}');
  await writeFile(path.join(publicDir, 'app.js'), '');
  await writeFile(apkPath, 'apk');
  try {
    const runtime = await runtimeModule.createMobileRuntime({
      adminToken: 'mobile-admin-0123456789abcdef-strong',
      controlPlane: {
        mobileSnapshot() { return {devices: []}; },
        async requestMobileMediation() { throw new Error('unused'); }
      },
      ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
      stateDir: path.join(root, 'state'),
      publicDir,
      apkPath
    });
    assert.equal(runtime.enabled, true);
    assert.equal(typeof runtime.handler, 'function');
    assert.equal(runtime.voiceSettingsStore, null);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
