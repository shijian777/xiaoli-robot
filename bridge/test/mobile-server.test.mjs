import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../src/server.mjs';

const adminToken = 'mobile-admin-0123456789abcdef-strong';

test('startBridge wires the mobile page and authenticated API into the gateway HTTP server', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xiaoli-mobile-server-'));
  let voice = {voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50};
  const config = {
    baseUrl: 'https://agent-stack.example.test',
    uak: 'test-uak',
    projectId: 'test-project',
    asrAgentId: null,
    mediatorAgentId: 'test-mediator',
    deviceToken: 'device-token',
    mobileAdminToken: adminToken,
    host: '127.0.0.1',
    port: 0,
    mdnsEnabled: false,
    tempDir: path.join(root, 'tmp'),
    stateDir: path.join(root, 'state'),
    ttsProvider: 'xfyun',
    xfyunRtasr: null,
    xfyunTts: null
  };
  const runtime = await startBridge({
    config,
    client: {async createSession() { return 'unused'; }},
    asrService: {async transcribe() { throw new Error('unused'); }},
    mediatorService: {async mediate() { throw new Error('unused'); }},
    ttsService: {
      async synthesize() { throw new Error('unused'); },
      getVoiceSettings() { return {...voice}; },
      updateVoiceSettings(value) { voice = {...value}; return {...voice}; }
    },
    logger: {info() {}, warn() {}, error() {}}
  });
  try {
    const origin = `http://127.0.0.1:${runtime.address.port}`;
    const page = await fetch(`${origin}/mobile/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /小理/);

    const unauthorized = await fetch(`${origin}/api/mobile/v1/status`);
    assert.equal(unauthorized.status, 401);

    const status = await fetch(`${origin}/api/mobile/v1/status`, {
      headers: {authorization: `Bearer ${adminToken}`}
    });
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.deepEqual(body.devices, []);
    assert.deepEqual(body.voice, voice);
    assert.equal(body.version, 1);
    assert.equal(runtime.mobile.enabled, true);
  } finally {
    await runtime.shutdown();
    await rm(root, {recursive: true, force: true});
  }
});
