import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

const valid = {
  AGENT_STACK_BASE_URL: 'https://ventured-agent-stack.pingcap.cn',
  AGENT_STACK_USER_API_KEY: 'test-uak-not-real',
  AGENT_STACK_PROJECT_ID: 'project_test',
  ASR_AGENT_ID: 'agent_asr',
  MEDIATOR_AGENT_ID: 'agent_mediator',
  DEVICE_SHARED_TOKEN: 'device-test-token'
};

test('loadConfig returns fixed local defaults', () => {
  const cfg = loadConfig(valid);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 8788);
  assert.equal(cfg.sampleRate, 16000);
  assert.equal(cfg.channels, 1);
});

test('loadConfig rejects a missing secret', () => {
  const env = {...valid};
  delete env.AGENT_STACK_USER_API_KEY;
  assert.throws(() => loadConfig(env), /AGENT_STACK_USER_API_KEY/);
});
