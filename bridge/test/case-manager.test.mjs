import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseManager } from '../src/case-manager.mjs';

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

test('accepts exactly 1,920,000 PCM bytes and rejects growth beyond the segment cap', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'boundary', 'A'));
  cases.appendChunk('boundary', 0, Buffer.alloc(1_920_000));
  assert.equal(cases.endSegment('boundary').pcm.length, 1_920_000);

  cases.startSegment(segment('case-1', 'overflow', 'B'));
  cases.appendChunk('overflow', 0, Buffer.alloc(1_920_000));
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
