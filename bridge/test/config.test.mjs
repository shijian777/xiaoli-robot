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

test('loadConfig rejects an invalid Agent Stack URL', () => {
  const env = {...valid, AGENT_STACK_BASE_URL: 'not-a-url'};
  assert.throws(() => loadConfig(env), /AGENT_STACK_BASE_URL.*valid URL/);
});

test('loadConfig rejects a port outside the valid range', () => {
  for (const BRIDGE_PORT of ['0', '65536', '8.5', 'not-a-port']) {
    assert.throws(() => loadConfig({...valid, BRIDGE_PORT}), /BRIDGE_PORT/);
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
    nested: {authorization: 'Bearer secret', safe: 'preserved'},
    items: [{deviceToken: 'device-secret', count: 2}]
  };
  const original = structuredClone(payload);

  logger.info(payload);

  assert.deepEqual(entries[0].args[0], {
    uak: '[REDACTED]',
    nested: {authorization: '[REDACTED]', safe: 'preserved'},
    items: [{deviceToken: '[REDACTED]', count: 2}]
  });
  assert.deepEqual(payload, original);
});
