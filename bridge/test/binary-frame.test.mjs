import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameKind,
  encodeBinaryFrame,
  decodeBinaryFrame
} from '../src/protocol/binary-frame.mjs';
import {
  validateDeviceMessage,
  validateMediatorResult
} from '../src/protocol/schemas.mjs';

test('encodes the XL v1 eight-byte header', () => {
  const frame = encodeBinaryFrame({
    kind: FrameKind.STREAM_CHUNK,
    streamType: 2,
    flags: 0,
    sequence: 513,
    payload: Buffer.from([0x11, 0x22])
  });
  assert.deepEqual([...frame], [0x58, 0x4c, 1, 3, 2, 0, 1, 2, 0x11, 0x22]);
  assert.deepEqual(decodeBinaryFrame(frame), {
    version: 1,
    kind: 3,
    streamType: 2,
    flags: 0,
    sequence: 513,
    payload: Buffer.from([0x11, 0x22])
  });
});

test('rejects bad magic and unsupported version', () => {
  assert.throws(() => decodeBinaryFrame(Buffer.from([0, 0, 1, 3, 2, 0, 0, 0])), /magic/);
  assert.throws(() => decodeBinaryFrame(Buffer.from([0x58, 0x4c, 2, 3, 2, 0, 0, 0])), /version/);
});

test('rejects invalid frame fields and payload sizes', () => {
  const payload = Buffer.alloc(1);
  for (const [field, value] of [
    ['kind', 0],
    ['kind', 5],
    ['streamType', -1],
    ['streamType', 5],
    ['sequence', -1],
    ['sequence', 65536],
    ['flags', 256]
  ]) {
    assert.throws(() => encodeBinaryFrame({kind: field === 'kind' ? value : FrameKind.CONTROL,
      streamType: field === 'streamType' ? value : 0,
      flags: field === 'flags' ? value : 0,
      sequence: field === 'sequence' ? value : 0,
      payload}), new RegExp(field));
  }
  assert.throws(() => encodeBinaryFrame({kind: FrameKind.CONTROL, streamType: 0, flags: 0,
    sequence: 0, payload: Buffer.alloc(65536)}), /payload/);
  assert.throws(() => decodeBinaryFrame(Buffer.alloc(7)), /eight|short|header/);
});

test('validates speech.start device metadata and fixed audio format', () => {
  const valid = {
    v: 1,
    type: 'speech.start',
    messageId: 'message-1',
    caseId: 'case-1',
    segmentId: 'segment-1',
    speaker: 'A',
    audio: {sampleRate: 16000, bits: 16, channels: 1}
  };
  assert.equal(validateDeviceMessage(valid), true);
  assert.equal(validateDeviceMessage({...valid, speaker: 'C'}), false);
  assert.equal(validateDeviceMessage({...valid, audio: {...valid.audio, sampleRate: 8000}}), false);
  assert.equal(validateDeviceMessage({...valid, audio: {...valid.audio, extra: true}}), false);
  assert.equal(validateDeviceMessage({...valid, messageId: ''}), false);
});

test('validates type-specific device messages', () => {
  assert.equal(validateDeviceMessage({
    v: 1, type: 'hello', messageId: 'hello-1', deviceId: 'device-1',
    firmwareVersion: '1.0.0', token: 'device-token', capabilities: ['audio']
  }), true);
  assert.equal(validateDeviceMessage({v: 1, type: 'case.start', messageId: 'case-1', caseId: 'case-1'}), true);
  assert.equal(validateDeviceMessage({v: 1, type: 'mediate.request', messageId: 'request-1', caseId: 'case-1'}), true);
  assert.equal(validateDeviceMessage({
    v: 1, type: 'speech.end', messageId: 'end-1', caseId: 'case-1', segmentId: 'segment-1',
    bytes: 3200, lastSequence: 3, complete: true
  }), true);
  assert.equal(validateDeviceMessage({v: 1, type: 'unknown', messageId: 'x'}), false);
  assert.equal(validateDeviceMessage({v: 1, type: 'case.start', messageId: 'x'}), false);
});

test('validates mediation results with all fields and a non-empty suggestion', () => {
  const valid = {
    conflictSummary: '核心矛盾',
    aPosition: 'A 的立场与诉求',
    bPosition: 'B 的立场与诉求',
    aCanImprove: 'A 可以改善的地方',
    bCanImprove: 'B 可以改善的地方',
    commonGround: '双方共同点',
    suggestions: ['建议一'],
    spokenText: '适合设备播放的话术'
  };
  assert.equal(validateMediatorResult(valid), true);
  assert.equal(validateMediatorResult({...valid, suggestions: []}), false);
  assert.equal(validateMediatorResult({...valid, suggestions: ['']}), false);
  assert.equal(validateMediatorResult({...valid, spokenText: ''}), false);
  assert.equal(validateMediatorResult({...valid, extra: true}), false);
});
