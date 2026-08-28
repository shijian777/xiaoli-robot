import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runFakeDevice} from '../scripts/fake-device.mjs';
import {makeAudiblePcm, startHardwareMock} from '../scripts/hardware-mock.mjs';
import {parsePcmWav} from '../src/audio/wav.mjs';

test('hardware mock completes A/B recording and audible playback without cloud credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-hardware-mock-'));
  const outputPath = path.join(directory, 'result.wav');
  const advertisements = [];
  const bonjour = {
    publish(options) {
      advertisements.push(options);
      return {stop(callback) { callback?.(); }};
    },
    destroy(callback) { callback?.(); }
  };
  const events = [];
  let runtime;
  try {
    runtime = await startHardwareMock({
      token: 'hardware-mock-test-token',
      host: '127.0.0.1',
      port: 0,
      tempDir: directory,
      bonjourFactory: () => bonjour,
      logger: {
        info(entry) { events.push(entry); },
        warn() {},
        error() {}
      }
    });
    const result = await runFakeDevice({
      url: `ws://127.0.0.1:${runtime.address.port}/device`,
      token: 'hardware-mock-test-token',
      outputPath
    });
    const playback = parsePcmWav(await readFile(result.outputPath));
    assert.equal(result.bytes, 16_000 * 3 * 2);
    assert.equal(playback.pcm.length, result.bytes);
    assert.ok(playback.pcm.some((byte) => byte !== 0));
    assert.equal(events.filter((entry) => entry?.event === 'hardware_mock.recording_received').length, 2);
    assert.equal(advertisements[0].host, 'xiaoli-bridge.local');
  } finally {
    await runtime?.shutdown();
    await rm(directory, {recursive: true, force: true});
  }
});

test('audible mock PCM is bounded 16-bit audio', () => {
  const pcm = makeAudiblePcm({seconds: 0.1});
  assert.equal(pcm.length, 16_000 * 0.1 * 2);
  let peak = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }
  assert.ok(peak >= 11_000 && peak <= 12_000);
  assert.throws(() => makeAudiblePcm({seconds: 31}), /seconds/);
});
