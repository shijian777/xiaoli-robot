import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';

const valid = {
  AGENT_STACK_BASE_URL: 'https://ventured-agent-stack.pingcap.cn',
  AGENT_STACK_USER_API_KEY: 'test-uak-not-real',
  AGENT_STACK_PROJECT_ID: 'project_test',
  ASR_AGENT_ID: 'agent_asr',
  MEDIATOR_AGENT_ID: 'agent_mediator',
  DEVICE_SHARED_TOKEN: 'device-test-token'
};

const withXfyun = {
  AGENT_STACK_BASE_URL: valid.AGENT_STACK_BASE_URL,
  AGENT_STACK_USER_API_KEY: valid.AGENT_STACK_USER_API_KEY,
  AGENT_STACK_PROJECT_ID: valid.AGENT_STACK_PROJECT_ID,
  MEDIATOR_AGENT_ID: valid.MEDIATOR_AGENT_ID,
  DEVICE_SHARED_TOKEN: valid.DEVICE_SHARED_TOKEN,
  XFYUN_RTASR_APP_ID: 'test-app-id',
  XFYUN_RTASR_API_KEY: 'test-api-key-not-real'
};

const withXfyunTts = {
  ...valid,
  TTS_PROVIDER: 'xfyun',
  XFYUN_TTS_APP_ID: 'tts-app-id',
  XFYUN_TTS_API_KEY: 'tts-api-key-not-real',
  XFYUN_TTS_API_SECRET: 'tts-api-secret-not-real'
};

test('loadConfig returns fixed local defaults', () => {
  const cfg = loadConfig(valid);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 8788);
  assert.equal(cfg.mdnsEnabled, true);
  assert.equal(cfg.sampleRate, 16000);
  assert.equal(cfg.channels, 1);
  assert.equal(cfg.stateDir, 'state');
});

test('loadConfig accepts an explicit durable state directory separate from audio temp', () => {
  const cfg = loadConfig({
    ...valid,
    BRIDGE_TEMP_DIR: 'D:\\xiaoli\\tmp',
    BRIDGE_STATE_DIR: 'D:\\xiaoli\\state'
  });

  assert.equal(cfg.tempDir, 'D:\\xiaoli\\tmp');
  assert.equal(cfg.stateDir, 'D:\\xiaoli\\state');
});

test('loadConfig accepts only explicit boolean mDNS settings', () => {
  assert.equal(loadConfig({...valid, BRIDGE_MDNS_ENABLED: 'false'}).mdnsEnabled, false);
  assert.equal(loadConfig({...valid, BRIDGE_MDNS_ENABLED: 'true'}).mdnsEnabled, true);
  for (const BRIDGE_MDNS_ENABLED of ['', 'False', '0', 'yes']) {
    assert.throws(() => loadConfig({...valid, BRIDGE_MDNS_ENABLED}), /BRIDGE_MDNS_ENABLED/);
  }
});

test('loadConfig rejects a missing secret', () => {
  const env = {...valid};
  delete env.AGENT_STACK_USER_API_KEY;
  assert.throws(() => loadConfig(env), /AGENT_STACK_USER_API_KEY/);
});

test('loadConfig rejects an invalid Agent Stack URL', () => {
  const env = {...valid, AGENT_STACK_BASE_URL: 'not-a-url'};
  assert.throws(() => loadConfig(env), /AGENT_STACK_BASE_URL.*valid URL/);
});

test('loadConfig permits HTTP only for an explicit loopback Agent Stack host', () => {
  for (const AGENT_STACK_BASE_URL of [
    'http://127.0.0.1:8788',
    'http://localhost:8788',
    'http://[::1]:8788'
  ]) {
    assert.equal(loadConfig({...valid, AGENT_STACK_BASE_URL}).baseUrl, AGENT_STACK_BASE_URL);
  }
});

test('loadConfig rejects plaintext or non-HTTP Agent Stack URLs outside loopback', () => {
  for (const AGENT_STACK_BASE_URL of [
    'http://agent-stack.example.test',
    'http://127.0.0.2:8788',
    'http://localhost.example.test:8788',
    'ftp://agent-stack.example.test'
  ]) {
    assert.throws(
      () => loadConfig({...valid, AGENT_STACK_BASE_URL}),
      /AGENT_STACK_BASE_URL must use HTTPS/
    );
  }
});

test('loadConfig rejects a port outside the valid range', () => {
  for (const BRIDGE_PORT of ['0', '65536', '8.5', 'not-a-port', '0x10', '1e3', '+12', ' 8788 ']) {
    assert.throws(() => loadConfig({...valid, BRIDGE_PORT}), /BRIDGE_PORT/);
  }
});

test('loadConfig enables Xfyun RTASR only when both credentials are present', () => {
  const cfg = loadConfig(withXfyun);
  assert.equal(cfg.asrAgentId, null);
  assert.deepEqual(cfg.xfyunRtasr, {
    appId: 'test-app-id',
    apiKey: 'test-api-key-not-real'
  });

  for (const missing of ['XFYUN_RTASR_APP_ID', 'XFYUN_RTASR_API_KEY']) {
    const env = {...withXfyun};
    delete env[missing];
    assert.throws(() => loadConfig(env), /XFYUN_RTASR_APP_ID.*XFYUN_RTASR_API_KEY/);
  }

  assert.equal(loadConfig(valid).xfyunRtasr, null);
});

test('loadConfig requires an ASR Agent ID when Xfyun is not configured', () => {
  const env = {...valid};
  delete env.ASR_AGENT_ID;
  assert.throws(() => loadConfig(env), /ASR_AGENT_ID/);
});

test('loadConfig enables Xfyun TTS only with a complete credential set', () => {
  const cfg = loadConfig(withXfyunTts);
  assert.equal(cfg.ttsProvider, 'xfyun');
  assert.deepEqual(cfg.xfyunTts, {
    appId: 'tts-app-id',
    apiKey: 'tts-api-key-not-real',
    apiSecret: 'tts-api-secret-not-real',
    voice: 'x4_xiaoyan',
    speed: 50,
    volume: 50,
    pitch: 50
  });

  const custom = loadConfig({
    ...withXfyunTts,
    XFYUN_TTS_VOICE: 'x4_yezi',
    XFYUN_TTS_SPEED: '65',
    XFYUN_TTS_VOLUME: '70',
    XFYUN_TTS_PITCH: '35'
  });
  assert.deepEqual(custom.xfyunTts, {
    appId: 'tts-app-id',
    apiKey: 'tts-api-key-not-real',
    apiSecret: 'tts-api-secret-not-real',
    voice: 'x4_yezi',
    speed: 65,
    volume: 70,
    pitch: 35
  });

  for (const missing of [
    'XFYUN_TTS_APP_ID', 'XFYUN_TTS_API_KEY', 'XFYUN_TTS_API_SECRET'
  ]) {
    const env = {...withXfyunTts};
    delete env[missing];
    assert.throws(() => loadConfig(env), /XFYUN_TTS_APP_ID.*XFYUN_TTS_API_KEY.*XFYUN_TTS_API_SECRET/);
  }
});

test('loadConfig rejects incomplete or malformed Xfyun TTS settings', () => {
  assert.throws(
    () => loadConfig({...valid, XFYUN_TTS_APP_ID: 'orphan'}),
    /XFYUN_TTS_APP_ID.*XFYUN_TTS_API_KEY.*XFYUN_TTS_API_SECRET/
  );
  assert.throws(
    () => loadConfig({...withXfyunTts, XFYUN_TTS_VOICE: '../unsafe'}),
    /XFYUN_TTS_VOICE/
  );
  for (const [name, value] of [
    ['XFYUN_TTS_SPEED', '-1'],
    ['XFYUN_TTS_SPEED', '101'],
    ['XFYUN_TTS_VOLUME', '50.5'],
    ['XFYUN_TTS_PITCH', 'loud']
  ]) {
    assert.throws(
      () => loadConfig({...withXfyunTts, [name]: value}),
      new RegExp(name)
    );
  }
  assert.throws(
    () => loadConfig({...valid, TTS_PROVIDER: 'xfyun'}),
    /XFYUN.*TTS.*credentials/i
  );
});

test('loadConfig accepts the existing local TTS providers', () => {
  assert.equal(loadConfig({...valid, TTS_PROVIDER: 'windows'}).ttsProvider, 'windows');
  assert.equal(loadConfig({...valid, TTS_PROVIDER: 'espeak-ng'}).ttsProvider, 'espeak-ng');
  assert.equal(loadConfig(valid).ttsProvider, '');
  assert.throws(() => loadConfig({...valid, TTS_PROVIDER: 'unknown'}), /TTS_PROVIDER/);
});

test('loadConfig keeps the mobile admin API disabled unless a strong independent token is set', () => {
  assert.equal(loadConfig(valid).mobileAdminToken, null);
  const token = 'mobile-admin-0123456789abcdef-strong';
  assert.equal(loadConfig({...valid, MOBILE_ADMIN_TOKEN: token}).mobileAdminToken, token);

  for (const MOBILE_ADMIN_TOKEN of [
    '', 'short-token', `token-${'x'.repeat(300)}`, ' token-with-leading-space',
    'token with embedded whitespace that is long enough'
  ]) {
    const run = () => loadConfig({...valid, MOBILE_ADMIN_TOKEN});
    if (MOBILE_ADMIN_TOKEN === '') assert.equal(run().mobileAdminToken, null);
    else assert.throws(run, /MOBILE_ADMIN_TOKEN/);
  }
});

test('logger redacts direct string arguments', () => {
  const entries = [];
  const logger = createLogger((entry) => entries.push(entry));
  logger.info('full transcribed statement with private details');
  logger.info('real-uak-secret');
  assert.equal(entries[0].args[0], '[REDACTED]');
  assert.equal(entries[1].args[0], '[REDACTED]');
});

test('logger recursively redacts uak and secret-shaped keys without mutating input', () => {
  const entries = [];
  const logger = createLogger((entry) => entries.push(entry));
  const payload = {
    uak: 'real-uak-secret',
    apiSecret: 'real-xfyun-api-secret',
    secret: 'generic-secret',
    nested: {
      authorization: 'Bearer secret',
      clientSecret: 'nested-secret',
      safe: 'preserved'
    },
    items: [{deviceToken: 'device-secret', count: 2}]
  };
  const original = structuredClone(payload);

  logger.info(payload);

  assert.deepEqual(entries[0].args[0], {
    uak: '[REDACTED]',
    apiSecret: '[REDACTED]',
    secret: '[REDACTED]',
    nested: {
      authorization: '[REDACTED]',
      clientSecret: '[REDACTED]',
      safe: 'preserved'
    },
    items: [{deviceToken: '[REDACTED]', count: 2}]
  });
  assert.deepEqual(payload, original);
});
