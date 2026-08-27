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

test('rejects a reused segment identity with conflicting metadata', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  cases.startSegment(segment('case-1', 'seg-1', 'A'));

  assert.throws(() => cases.startSegment(segment('case-1', 'seg-1', 'B')), /conflict/);
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
