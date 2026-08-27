import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePcmWav, pcmToWav } from '../src/audio/wav.mjs';

const approvedAudio = {sampleRate: 16000, bits: 16, channels: 1};

test('builds a canonical 16 kHz mono PCM WAV header', () => {
  const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00]);

  const wav = pcmToWav(pcm, approvedAudio);

  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 44);
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wav.readUInt32LE(40), 8);
  assert.deepEqual(parsePcmWav(wav), {...approvedAudio, pcm});
});

test('rejects non-buffer, odd PCM, and unsupported audio formats', () => {
  assert.throws(() => pcmToWav(new Uint8Array([1, 2]), approvedAudio), /Buffer/);
  assert.throws(() => pcmToWav(Buffer.from([1]), approvedAudio), /even|odd|PCM/);
  for (const audio of [
    {sampleRate: 8000, bits: 16, channels: 1},
    {sampleRate: 16000, bits: 8, channels: 1},
    {sampleRate: 16000, bits: 16, channels: 2}
  ]) {
    assert.throws(() => pcmToWav(Buffer.alloc(2), audio), /16000|16-bit|mono|audio format/);
  }
});

test('rejects WAV containers that are not the approved PCM format', () => {
  const wav = pcmToWav(Buffer.alloc(2), approvedAudio);
  wav.writeUInt16LE(3, 20);

  assert.throws(() => parsePcmWav(wav), /PCM|format/);
});
