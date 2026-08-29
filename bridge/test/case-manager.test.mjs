import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CaseManager,
  MAX_SEGMENT_TOMBSTONES
} from '../src/case-manager.mjs';

const audio = {sampleRate: 16000, bits: 16, channels: 1};
const segment = (caseId, segmentId, speaker) => ({caseId, segmentId, speaker, audio});

test('does not duplicate a retried segment or chunk', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  const meta = segment('case-1', 'seg-1', 'A');

  cases.startSegment(meta);
  cases.startSegment(meta);
  cases.appendChunk('seg-1', 0, Buffer.from([1, 2]));
  cases.appendChunk('seg-1', 0, Buffer.from([1, 2]));

  assert.equal(cases.endSegment('seg-1').pcm.length, 2);
  assert.equal(cases.snapshot('case-1').speakers.A.length, 1);
});

test('accepts an exact chunk retry after a segment is queued', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'seg-1', 'A'));
  cases.appendChunk('seg-1', 0, Buffer.from([1, 2]));
  cases.endSegment('seg-1');

  cases.appendChunk('seg-1', 0, Buffer.from([1, 2]));

  assert.equal(cases.endSegment('seg-1').pcm.length, 2);
});

test('rejects a missing audio sequence before accepting later chunks', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'seg-1', 'A'));
  cases.appendChunk('seg-1', 0, Buffer.from([1, 2]));

  assert.throws(() => cases.appendChunk('seg-1', 2, Buffer.from([3, 4])), /missing audio sequence 1/);
});

test('rejects an odd-length PCM chunk before it enters a segment', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'seg-1', 'A'));

  assert.throws(() => cases.appendChunk('seg-1', 0, Buffer.from([1])), /even|16-bit|PCM/);
});

test('rejects a reused segment identity with conflicting metadata', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'seg-1', 'A'));

  assert.throws(() => cases.startSegment(segment('case-1', 'seg-1', 'B')), /conflict/);
});

test('retains only immutable segment identity metadata after case eviction to reject cross-case reuse', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'shared-segment', 'A'));
  assert.equal(Object.isFrozen(cases.segments.get('shared-segment').audio), true);
  assert.throws(() => { cases.segments.get('shared-segment').audio.sampleRate = 8_000; }, TypeError);
  cases.appendChunk('shared-segment', 0, Buffer.from([1, 2]));
  cases.failSegment('shared-segment', 'finished with an error');
  cases.startCase('device-1', 'case-2');

  assert.throws(() => cases.startSegment(segment('case-2', 'shared-segment', 'A')), /conflict/);
});

test('snapshots retain input order separately for each hardware speaker', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  for (const [id, speaker, transcript] of [
    ['a-1', 'A', 'A first'],
    ['b-1', 'B', 'B first'],
    ['a-2', 'A', 'A second'],
    ['b-2', 'B', 'B second']
  ]) {
    cases.startSegment(segment('case-1', id, speaker));
    cases.appendChunk(id, 0, Buffer.from([1, 2]));
    cases.endSegment(id);
    cases.saveTranscript(id, transcript);
  }

  const snapshot = cases.snapshot('case-1');
  assert.deepEqual(snapshot.speakers.A.map(({segmentId, transcript}) => ({segmentId, transcript})), [
    {segmentId: 'a-1', transcript: 'A first'},
    {segmentId: 'a-2', transcript: 'A second'}
  ]);
  assert.deepEqual(snapshot.speakers.B.map(({segmentId, transcript}) => ({segmentId, transcript})), [
    {segmentId: 'b-1', transcript: 'B first'},
    {segmentId: 'b-2', transcript: 'B second'}
  ]);
  assert.equal(snapshot.canMediate, true);
});

test('only enables mediation after non-empty saved transcripts for both speakers and no active segment', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'a-1', 'A'));
  cases.appendChunk('a-1', 0, Buffer.from([1, 2]));
  cases.endSegment('a-1');
  cases.saveTranscript('a-1', 'A statement');
  cases.startSegment(segment('case-1', 'b-1', 'B'));
  cases.appendChunk('b-1', 0, Buffer.from([1, 2]));
  cases.endSegment('b-1');
  cases.saveTranscript('b-1', '');

  assert.equal(cases.snapshot('case-1').canMediate, false);

  cases.startSegment(segment('case-1', 'a-2', 'A'));
  assert.equal(cases.snapshot('case-1').canMediate, false);
});

test('starting a new case evicts the prior device case and all of its segments', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'old-a', 'A'));
  cases.appendChunk('old-a', 0, Buffer.from([1, 2]));
  cases.endSegment('old-a');
  cases.saveTranscript('old-a', 'old private transcript');

  cases.startCase('device-1', 'case-2');

  assert.equal(cases.currentCaseId('device-1'), 'case-2');
  assert.throws(() => cases.snapshot('case-1'), /unknown case/);
  assert.throws(() => cases.startSegment(segment('case-1', 'late-a', 'A')), /unknown case/);
  assert.throws(() => cases.appendChunk('old-a', 0, Buffer.from([1, 2])), /unknown segment/);
  assert.deepEqual(cases.snapshot('case-2').speakers, {A: [], B: []});
});

test('releases raw chunks and assembled PCM after durable staging or terminal failure', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'staged-a', 'A'));
  cases.appendChunk('staged-a', 0, Buffer.from([1, 2, 3, 4]));
  assert.equal(cases.endSegment('staged-a').pcm.length, 4);

  cases.releaseAudio('staged-a');

  assert.equal(cases.segments.get('staged-a').chunks.size, 0);
  assert.equal(cases.segments.get('staged-a').pcm, null);
  assert.throws(() => cases.endSegment('staged-a'), /released|no assembled PCM/);
  assert.throws(() => cases.appendChunk('staged-a', 0, Buffer.from([1, 2, 3, 4])), /not receiving/);

  cases.startSegment(segment('case-1', 'failed-b', 'B'));
  cases.appendChunk('failed-b', 0, Buffer.from([5, 6]));
  cases.failSegment('failed-b', 'terminal failure');
  assert.equal(cases.segments.get('failed-b').chunks.size, 0);
  assert.equal(cases.segments.get('failed-b').pcm, null);
  assert.throws(() => cases.appendChunk('failed-b', 0, Buffer.from([5, 6])), /not receiving/);
});

test('accepts ten minutes of PCM and rejects growth beyond the segment cap', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'boundary', 'A'));
  cases.appendChunk('boundary', 0, Buffer.alloc(19_200_000));
  assert.equal(cases.endSegment('boundary').pcm.length, 19_200_000);

  cases.startSegment(segment('case-1', 'overflow', 'B'));
  cases.appendChunk('overflow', 0, Buffer.alloc(19_200_000));
  assert.throws(() => cases.appendChunk('overflow', 1, Buffer.alloc(2)), (error) => {
    assert.equal(error.code, 'audio_size_limit_exceeded');
    assert.doesNotMatch(error.message, /case-1|overflow/);
    return true;
  });
});

test('allows exactly 64 segments per case and rejects the sixty-fifth', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  for (let index = 0; index < 64; index += 1) {
    cases.startSegment(segment('case-1', `segment-${index}`, index % 2 === 0 ? 'A' : 'B'));
  }

  assert.throws(() => cases.startSegment(segment('case-1', 'segment-64', 'A')), (error) => {
    assert.equal(error.code, 'case_segment_limit_exceeded');
    assert.doesNotMatch(error.message, /case-1|segment-64/);
    return true;
  });
});

test('accepts 71-byte persisted identifiers and rejects 72-byte live and restored identifiers', () => {
  const max = 'i'.repeat(71);
  const oversized = 'i'.repeat(72);
  const cases = new CaseManager();
  cases.startCase(max, max);
  cases.startSegment(segment(max, max, 'A'));
  assert.equal(cases.snapshot(max).speakers.A[0].segmentId, max);

  assert.throws(() => cases.startCase(oversized, 'next-case'), /identifier|71|length/i);
  assert.throws(() => cases.startSegment(segment(max, oversized, 'B')), /identifier|71|length/i);

  const invalid = cases.exportState();
  invalid.currentCases[0][0] = oversized;
  const restored = new CaseManager();
  restored.startCase('live-device', 'live-case');
  assert.throws(() => restored.restoreState(invalid), /identifier|71|length/i);
  assert.equal(restored.currentCaseId('live-device'), 'live-case');
});

test('bounds transcript and failure text in live and restored segment state', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'saved-at-max', 'A'));
  cases.appendChunk('saved-at-max', 0, Buffer.from([1, 0]));
  cases.endSegment('saved-at-max');
  cases.saveTranscript('saved-at-max', '字'.repeat(32_000));
  assert.equal(cases.snapshot('case-1').speakers.A[0].transcript.length, 32_000);

  cases.startSegment(segment('case-1', 'saved-too-long', 'B'));
  cases.appendChunk('saved-too-long', 0, Buffer.from([1, 0]));
  cases.endSegment('saved-too-long');
  assert.throws(() => cases.saveTranscript('saved-too-long', '字'.repeat(32_001)), /transcript.*32000|limit/i);

  cases.startSegment(segment('case-1', 'failure-at-max', 'B'));
  assert.doesNotThrow(() => cases.failSegment('failure-at-max', 'f'.repeat(256)));
  cases.startSegment(segment('case-1', 'failure-too-long', 'B'));
  assert.throws(() => cases.failSegment('failure-too-long', 'f'.repeat(257)), /failure.*256|limit/i);

  const invalid = cases.exportState();
  invalid.segments.find(({segmentId}) => segmentId === 'saved-at-max').transcript = '字'.repeat(32_001);
  const restored = new CaseManager();
  restored.startCase('live-device', 'live-case');
  assert.throws(() => restored.restoreState(invalid), /transcript.*invalid|limit/i);
  assert.equal(restored.currentCaseId('live-device'), 'live-case');
});

test('rejects over-capacity restored collections before traversing malformed entries', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  const base = cases.exportState();
  const overCapacity = [
    {...base, currentCases: Array(129).fill(null)},
    {...base, cases: Array(129).fill(null)},
    {...base, segments: Array(128 * 64 + 1).fill(null)},
    {...base, segmentTombstones: Array(4097).fill(null)}
  ];

  for (const candidate of overCapacity) {
    const restored = new CaseManager();
    restored.startCase('live-device', 'live-case');
    assert.throws(() => restored.restoreState(candidate), /resource|capacity|limit|too many/i);
    assert.equal(restored.currentCaseId('live-device'), 'live-case');
  }
});

test('exports and restores current cases, pending work, saved transcripts, and segment identity tombstones', () => {
  const original = new CaseManager();
  original.startCase('device-1', 'case-1');
  original.startSegment(segment('case-1', 'saved-a', 'A'));
  original.appendChunk('saved-a', 0, Buffer.from([1, 0]));
  original.endSegment('saved-a');
  original.releaseAudio('saved-a');
  original.saveTranscript('saved-a', 'A 已保存陈述');
  original.startSegment(segment('case-1', 'queued-b', 'B'));
  original.appendChunk('queued-b', 0, Buffer.from([2, 0]));
  original.endSegment('queued-b');
  original.releaseAudio('queued-b');

  original.startCase('device-1', 'case-2');
  original.startSegment(segment('case-2', 'current-a', 'A'));
  original.appendChunk('current-a', 0, Buffer.from([3, 0]));
  original.endSegment('current-a');
  original.releaseAudio('current-a');
  original.saveTranscript('current-a', '当前案件陈述');

  const restored = new CaseManager();
  restored.restoreState(original.exportState());

  assert.equal(restored.currentCaseId('device-1'), 'case-2');
  assert.equal(restored.snapshot('case-2').speakers.A[0].transcript, '当前案件陈述');
  assert.throws(
    () => restored.startSegment(segment('case-2', 'saved-a', 'A')),
    /conflict/
  );
});

test('restores a queued segment without recreating raw PCM in memory', () => {
  const original = new CaseManager();
  original.startCase('device-1', 'case-1');
  original.startSegment(segment('case-1', 'queued-a', 'A'));
  original.appendChunk('queued-a', 0, Buffer.from([1, 0, 2, 0]));
  original.endSegment('queued-a');
  original.releaseAudio('queued-a');

  const restored = new CaseManager();
  restored.restoreState(original.exportState());

  assert.equal(restored.snapshot('case-1').speakers.A[0].state, 'queued');
  assert.throws(() => restored.endSegment('queued-a'), /released|no assembled PCM/);
  assert.doesNotThrow(() => restored.beginTranscription('queued-a'));
});

test('keeps a fixed recent segment tombstone window instead of growing forever', () => {
  const cases = new CaseManager();
  for (let index = 0; index < MAX_SEGMENT_TOMBSTONES + 2; index += 1) {
    const caseId = `case-${index}`;
    cases.startCase('device-1', caseId);
    cases.startSegment(segment(caseId, `segment-${index}`, 'A'));
  }
  cases.startCase('device-1', 'latest-case');

  const persisted = cases.exportState();
  assert.equal(persisted.segmentTombstones.length, MAX_SEGMENT_TOMBSTONES);
  const restored = new CaseManager();
  assert.doesNotThrow(() => restored.restoreState(persisted));
  assert.doesNotThrow(() => cases.startSegment(segment('latest-case', 'segment-0', 'A')));
  assert.throws(
    () => cases.startSegment(segment('latest-case', `segment-${MAX_SEGMENT_TOMBSTONES + 1}`, 'B')),
    /conflict/
  );
});

test('rejects malformed restore data without partially replacing live state', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'live-case');

  assert.throws(() => cases.restoreState({
    version: 1,
    currentCases: [['device-2', 'broken-case']],
    cases: [{deviceId: 'device-2', caseId: 'broken-case', speakers: {A: ['missing'], B: []}}],
    segments: [],
    segmentTombstones: []
  }), /restore|segment|state/i);
  assert.equal(cases.currentCaseId('device-1'), 'live-case');
});
