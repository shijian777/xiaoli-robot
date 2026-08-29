import assert from 'node:assert/strict';
import test from 'node:test';
import {ResilientTts} from '../src/tts/resilient-tts.mjs';

test('ResilientTts retries the primary once before succeeding', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const tts = new ResilientTts({
    primary: {async synthesize() {
      primaryCalls += 1;
      if (primaryCalls === 1) throw new Error('temporary upstream failure');
      return Buffer.from([1, 0]);
    }},
    fallback: {async synthesize() {
      fallbackCalls += 1;
      return Buffer.from([2, 0]);
    }}
  });

  assert.deepEqual(await tts.synthesize('调解内容'), Buffer.from([1, 0]));
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 0);
});

test('ResilientTts uses the local fallback after two primary failures', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const tts = new ResilientTts({
    primary: {async synthesize() {
      primaryCalls += 1;
      throw new Error('upstream unavailable');
    }},
    fallback: {async synthesize(text) {
      fallbackCalls += 1;
      assert.equal(text, '调解内容');
      return Buffer.from([3, 0]);
    }}
  });

  assert.deepEqual(await tts.synthesize('调解内容'), Buffer.from([3, 0]));
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 1);
});

test('ResilientTts never retries or falls back after cancellation', async () => {
  const controller = new AbortController();
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const tts = new ResilientTts({
    primary: {async synthesize() {
      primaryCalls += 1;
      controller.abort();
      throw new DOMException('cancelled', 'AbortError');
    }},
    fallback: {async synthesize() {
      fallbackCalls += 1;
      return Buffer.from([4, 0]);
    }}
  });

  await assert.rejects(
    () => tts.synthesize('调解内容', {signal: controller.signal}),
    {name: 'AbortError'}
  );
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
});

test('ResilientTts rejects providers without synthesize methods', () => {
  assert.throws(() => new ResilientTts({primary: {}, fallback: {async synthesize() {}}}),
    /primary.*synthesize/);
  assert.throws(() => new ResilientTts({primary: {async synthesize() {}}, fallback: {}}),
    /fallback.*synthesize/);
});

test('ResilientTts proxies voice setting reads and updates to its primary provider', () => {
  let settings = {voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50};
  const primary = {
    async synthesize() { return Buffer.from([1, 0]); },
    getVoiceSettings() { return {...settings}; },
    updateVoiceSettings(patch) {
      settings = {...settings, ...patch};
      return {...settings};
    }
  };
  const tts = new ResilientTts({
    primary,
    fallback: {async synthesize() { return Buffer.from([2, 0]); }}
  });

  assert.deepEqual(tts.getVoiceSettings(), settings);
  assert.deepEqual(tts.updateVoiceSettings({speed: 72, pitch: 45}), {
    voice: 'x4_xiaoyan', speed: 72, volume: 50, pitch: 45
  });
  assert.deepEqual(tts.getVoiceSettings(), {
    voice: 'x4_xiaoyan', speed: 72, volume: 50, pitch: 45
  });
});
