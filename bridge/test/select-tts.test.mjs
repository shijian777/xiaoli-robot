import assert from 'node:assert/strict';
import test from 'node:test';
import {selectTts} from '../src/tts/select-tts.mjs';

class FakeWindowsTts {}
class FakeEspeakTts {}
class FakeXfyunTts {
  constructor(options) { this.options = options; }
}
class FakeResilientTts {
  constructor(options) { this.options = options; }
}

test('selectTts uses an explicit provider regardless of platform', () => {
  assert.ok(selectTts({provider: 'windows', platform: 'linux', WindowsTtsClass: FakeWindowsTts, EspeakTtsClass: FakeEspeakTts}) instanceof FakeWindowsTts);
  assert.ok(selectTts({provider: 'espeak-ng', platform: 'win32', WindowsTtsClass: FakeWindowsTts, EspeakTtsClass: FakeEspeakTts}) instanceof FakeEspeakTts);
});

test('selectTts defaults to Windows only on win32', () => {
  assert.ok(selectTts({platform: 'win32', WindowsTtsClass: FakeWindowsTts, EspeakTtsClass: FakeEspeakTts}) instanceof FakeWindowsTts);
  assert.ok(selectTts({platform: 'linux', WindowsTtsClass: FakeWindowsTts, EspeakTtsClass: FakeEspeakTts}) instanceof FakeEspeakTts);
  assert.ok(selectTts({provider: '', platform: 'linux', WindowsTtsClass: FakeWindowsTts, EspeakTtsClass: FakeEspeakTts}) instanceof FakeEspeakTts);
});

test('selectTts rejects unknown providers', () => {
  assert.throws(() => selectTts({provider: 'cloud', WindowsTtsClass: FakeWindowsTts, EspeakTtsClass: FakeEspeakTts}), /TTS_PROVIDER.*windows.*espeak-ng/);
});

test('selectTts wraps Xfyun with one retry and a platform-local fallback', () => {
  const credentials = {
    appId: 'app', apiKey: 'key', apiSecret: 'secret', voice: 'x4_xiaoyan'
  };
  const linux = selectTts({
    provider: 'xfyun',
    platform: 'linux',
    xfyun: credentials,
    WindowsTtsClass: FakeWindowsTts,
    EspeakTtsClass: FakeEspeakTts,
    XfyunTtsClass: FakeXfyunTts,
    ResilientTtsClass: FakeResilientTts
  });
  assert.ok(linux instanceof FakeResilientTts);
  assert.ok(linux.options.primary instanceof FakeXfyunTts);
  assert.deepEqual(linux.options.primary.options, credentials);
  assert.ok(linux.options.fallback instanceof FakeEspeakTts);

  const windows = selectTts({
    provider: 'xfyun',
    platform: 'win32',
    xfyun: credentials,
    WindowsTtsClass: FakeWindowsTts,
    EspeakTtsClass: FakeEspeakTts,
    XfyunTtsClass: FakeXfyunTts,
    ResilientTtsClass: FakeResilientTts
  });
  assert.ok(windows.options.fallback instanceof FakeWindowsTts);
});

test('selectTts rejects Xfyun without validated credentials', () => {
  assert.throws(() => selectTts({
    provider: 'xfyun',
    XfyunTtsClass: FakeXfyunTts,
    ResilientTtsClass: FakeResilientTts
  }), /Xfyun TTS configuration/);
});
