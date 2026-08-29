import { assertApprovedPcmFormat } from './audio/wav.mjs';
import {assertProtocolIdentifier} from './protocol/limits.mjs';

const ACTIVE_STATES = new Set(['receiving', 'queued', 'transcribing']);
const TERMINAL_STATES = new Set(['saved', 'failed']);
export const MAX_PCM_BYTES_PER_SEGMENT = 19_200_000;
export const MAX_SEGMENTS_PER_CASE = 64;
export const MAX_SEGMENT_TOMBSTONES = 4096;
export const MAX_RETAINED_CASES = 128;
export const MAX_TRANSCRIPT_CHARACTERS = 32_000;
export const MAX_FAILURE_CHARACTERS = 256;

export class CaseResourceLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaseResourceLimitError';
    this.code = code;
  }
}

export class CaseManager {
  #segmentTombstones = new Map();
  #currentCases = new Map();
  #segmentTombstoneLimit;

  constructor({segmentTombstoneLimit = MAX_SEGMENT_TOMBSTONES} = {}) {
    if (!Number.isInteger(segmentTombstoneLimit) || segmentTombstoneLimit < 1) {
      throw new RangeError('segmentTombstoneLimit must be a positive integer');
    }
    this.#segmentTombstoneLimit = segmentTombstoneLimit;
    this.cases = new Map();
    this.segments = new Map();
  }

  startCase(deviceId, caseId) {
    assertIdentifier(deviceId, 'deviceId');
    assertIdentifier(caseId, 'caseId');
    const existing = this.cases.get(caseId);
    if (existing) {
      if (existing.deviceId !== deviceId) {
        throw new Error(`case ${caseId} conflicts with device ${existing.deviceId}`);
      }
      return snapshotCase(existing, this.segments);
    }

    const previousCaseId = this.#currentCases.get(deviceId);
    if (previousCaseId && previousCaseId !== caseId) this.#evictCase(previousCaseId);

    const caseRecord = {
      deviceId,
      caseId,
      speakers: {A: [], B: []}
    };
    this.cases.set(caseId, caseRecord);
    this.#currentCases.set(deviceId, caseId);
    return snapshotCase(caseRecord, this.segments);
  }

  currentCaseId(deviceId) {
    assertIdentifier(deviceId, 'deviceId');
    return this.#currentCases.get(deviceId);
  }

  startSegment(meta) {
    const normalized = normalizeMeta(meta);
    const binding = this.#segmentTombstones.get(normalized.segmentId);
    if (binding && !sameMeta(binding, normalized)) {
      throw new Error(`segment ${normalized.segmentId} conflicts with existing metadata`);
    }
    const existing = this.segments.get(normalized.segmentId);
    if (existing) {
      if (!sameMeta(existing, normalized)) {
        throw new Error(`segment ${normalized.segmentId} conflicts with existing metadata`);
      }
      // A pre-durable transport/storage failure is terminal for that attempt,
      // but firmware deliberately retains the exact segment and IDs until a
      // durable ACK.  Reopening the same metadata is therefore a recovery,
      // not a new business segment.
      if (existing.state === 'failed') {
        existing.chunks.clear();
        existing.receivedBytes = 0;
        existing.state = 'receiving';
        existing.pcm = null;
        existing.audioReleased = false;
        existing.transcript = null;
        existing.failure = null;
      }
      return snapshotSegment(existing);
    }

    const caseRecord = this.#requireCase(normalized.caseId);
    if (caseRecord.speakers.A.length + caseRecord.speakers.B.length >= MAX_SEGMENTS_PER_CASE) {
      throw new CaseResourceLimitError('case_segment_limit_exceeded', 'Case has reached the segment limit');
    }
    const segment = {
      ...normalized,
      chunks: new Map(),
      receivedBytes: 0,
      state: 'receiving',
      pcm: null,
      audioReleased: false,
      transcript: null,
      failure: null
    };
    this.segments.set(segment.segmentId, segment);
    caseRecord.speakers[segment.speaker].push(segment.segmentId);
    return snapshotSegment(segment);
  }

  appendChunk(segmentId, sequence, pcm) {
    const segment = this.#requireSegment(segmentId);
    assertSequence(sequence);
    if (!Buffer.isBuffer(pcm)) {
      throw new TypeError('audio chunk must be a Buffer');
    }
    assertEvenPcm(pcm);

    const existing = segment.chunks.get(sequence);
    if (existing) {
      if (!existing.equals(pcm)) {
        throw new Error(`audio sequence ${sequence} conflicts with existing chunk`);
      }
      return snapshotSegment(segment);
    }
    if (segment.state !== 'receiving') {
      throw new Error(`segment ${segmentId} is not receiving audio`);
    }
    if (segment.receivedBytes + pcm.length > MAX_PCM_BYTES_PER_SEGMENT) {
      throw new CaseResourceLimitError('audio_size_limit_exceeded', 'Recording audio exceeds the 10-minute limit');
    }

    const expected = segment.chunks.size;
    if (sequence !== expected) {
      throw new Error(`missing audio sequence ${expected}`);
    }
    segment.chunks.set(sequence, Buffer.from(pcm));
    segment.receivedBytes += pcm.length;
    return snapshotSegment(segment);
  }

  endSegment(segmentId) {
    const segment = this.#requireSegment(segmentId);
    if (segment.state === 'receiving') {
      segment.pcm = assemblePcm(segment.chunks);
      segment.state = 'queued';
    }
    return completedSegment(segment);
  }

  copyReceivingAudio(segmentId) {
    const segment = this.#requireSegment(segmentId);
    if (segment.state !== 'receiving') {
      throw new Error(`segment ${segmentId} is not receiving audio`);
    }
    return {
      ...snapshotSegment(segment),
      pcm: assemblePcm(segment.chunks)
    };
  }

  releaseAudio(segmentId) {
    const segment = this.#requireSegment(segmentId);
    if (segment.state === 'receiving') {
      throw new Error(`segment ${segmentId} is still receiving audio`);
    }
    releaseSegmentAudio(segment);
    return snapshotSegment(segment);
  }

  beginTranscription(segmentId) {
    const segment = this.#requireSegment(segmentId);
    if (segment.state === 'queued') {
      segment.state = 'transcribing';
    } else if (segment.state !== 'transcribing') {
      throw new Error(`segment ${segmentId} is not queued for transcription`);
    }
    return snapshotSegment(segment);
  }

  saveTranscript(segmentId, transcript) {
    const segment = this.#requireSegment(segmentId);
    if (typeof transcript !== 'string') {
      throw new TypeError('transcript must be a string');
    }
    if (transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
      throw new RangeError(`transcript exceeds the ${MAX_TRANSCRIPT_CHARACTERS}-character limit`);
    }
    if (segment.state === 'saved') {
      if (segment.transcript !== transcript) {
        throw new Error(`segment ${segmentId} conflicts with existing transcript`);
      }
      return snapshotSegment(segment);
    }
    if (segment.state !== 'queued' && segment.state !== 'transcribing') {
      throw new Error(`segment ${segmentId} is not ready to save a transcript`);
    }
    segment.transcript = transcript;
    segment.state = 'saved';
    releaseSegmentAudio(segment);
    return snapshotSegment(segment);
  }

  failSegment(segmentId, failure = 'transcription failed') {
    const segment = this.#requireSegment(segmentId);
    if (typeof failure !== 'string' || failure.length === 0) {
      throw new TypeError('failure must be a non-empty string');
    }
    if (failure.length > MAX_FAILURE_CHARACTERS) {
      throw new RangeError(`failure exceeds the ${MAX_FAILURE_CHARACTERS}-character limit`);
    }
    if (TERMINAL_STATES.has(segment.state)) {
      if (segment.state !== 'failed' || segment.failure !== failure) {
        throw new Error(`segment ${segmentId} cannot change terminal state`);
      }
      return snapshotSegment(segment);
    }
    segment.failure = failure;
    segment.state = 'failed';
    releaseSegmentAudio(segment);
    return snapshotSegment(segment);
  }

  snapshot(caseId) {
    return snapshotCase(this.#requireCase(caseId), this.segments);
  }

  exportState() {
    return {
      version: 1,
      currentCases: [...this.#currentCases],
      cases: [...this.cases.values()].map((record) => ({
        deviceId: record.deviceId,
        caseId: record.caseId,
        speakers: {A: [...record.speakers.A], B: [...record.speakers.B]}
      })),
      segments: [...this.segments.values()].map((record) => ({
        ...snapshotSegment(record),
        audioReleased: record.audioReleased === true
      })),
      segmentTombstones: [...this.#segmentTombstones.values()].map((binding) => ({
        caseId: binding.caseId,
        segmentId: binding.segmentId,
        speaker: binding.speaker,
        audio: {...binding.audio}
      }))
    };
  }

  restoreState(state) {
    const restored = validateRestoredState(state, this.#segmentTombstoneLimit);
    this.cases = restored.cases;
    this.segments = restored.segments;
    this.#currentCases = restored.currentCases;
    this.#segmentTombstones = restored.segmentTombstones;
  }

  #requireCase(caseId) {
    assertIdentifier(caseId, 'caseId');
    const caseRecord = this.cases.get(caseId);
    if (!caseRecord) {
      throw new Error(`unknown case ${caseId}`);
    }
    return caseRecord;
  }

  #requireSegment(segmentId) {
    assertIdentifier(segmentId, 'segmentId');
    const segment = this.segments.get(segmentId);
    if (!segment) {
      throw new Error(`unknown segment ${segmentId}`);
    }
    return segment;
  }

  #evictCase(caseId) {
    const caseRecord = this.cases.get(caseId);
    if (!caseRecord) return;
    for (const segmentId of [...caseRecord.speakers.A, ...caseRecord.speakers.B]) {
      const segment = this.segments.get(segmentId);
      if (segment) {
        releaseSegmentAudio(segment);
        this.#rememberSegmentTombstone(segment);
      }
      this.segments.delete(segmentId);
    }
    this.cases.delete(caseId);
    if (this.#currentCases.get(caseRecord.deviceId) === caseId) this.#currentCases.delete(caseRecord.deviceId);
  }

  #rememberSegmentTombstone(meta) {
    const binding = normalizeMeta(meta);
    this.#segmentTombstones.delete(binding.segmentId);
    this.#segmentTombstones.set(binding.segmentId, binding);
    while (this.#segmentTombstones.size > this.#segmentTombstoneLimit) {
      this.#segmentTombstones.delete(this.#segmentTombstones.keys().next().value);
    }
  }
}

function validateRestoredState(state, tombstoneLimit) {
  if (!state || typeof state !== 'object' || state.version !== 1 ||
      !Array.isArray(state.currentCases) || !Array.isArray(state.cases) ||
      !Array.isArray(state.segments) || !Array.isArray(state.segmentTombstones)) {
    throw new Error('CaseManager restore state is invalid');
  }
  if (state.currentCases.length > MAX_RETAINED_CASES ||
      state.cases.length > MAX_RETAINED_CASES ||
      state.segments.length > MAX_RETAINED_CASES * MAX_SEGMENTS_PER_CASE ||
      state.segmentTombstones.length > tombstoneLimit) {
    throw new Error('CaseManager restore state exceeds its resource limits');
  }

  const cases = new Map();
  for (const candidate of state.cases) {
    assertIdentifier(candidate?.deviceId, 'deviceId');
    assertIdentifier(candidate?.caseId, 'caseId');
    if (cases.has(candidate.caseId) || !candidate.speakers ||
        !Array.isArray(candidate.speakers.A) || !Array.isArray(candidate.speakers.B)) {
      throw new Error('CaseManager restore case is invalid');
    }
    const speakers = {A: [...candidate.speakers.A], B: [...candidate.speakers.B]};
    for (const segmentId of [...speakers.A, ...speakers.B]) assertIdentifier(segmentId, 'segmentId');
    if (new Set([...speakers.A, ...speakers.B]).size !== speakers.A.length + speakers.B.length ||
        speakers.A.length + speakers.B.length > MAX_SEGMENTS_PER_CASE) {
      throw new Error('CaseManager restore case segment list is invalid');
    }
    cases.set(candidate.caseId, {deviceId: candidate.deviceId, caseId: candidate.caseId, speakers});
  }

  const segments = new Map();
  for (const candidate of state.segments) {
    const meta = normalizeMeta(candidate);
    if (segments.has(meta.segmentId)) throw new Error('CaseManager restore segment is duplicated');
    const caseRecord = cases.get(meta.caseId);
    const listed = caseRecord?.speakers[meta.speaker]?.includes(meta.segmentId);
    if (!listed) throw new Error('CaseManager restore segment has no matching case binding');
    const allowedState = new Set(['receiving', 'queued', 'transcribing', 'saved', 'failed']);
    if (!allowedState.has(candidate.state)) throw new Error('CaseManager restore segment state is invalid');
    let stateName = candidate.state;
    let transcript = candidate.transcript ?? null;
    let failure = candidate.failure ?? null;
    if (stateName === 'receiving') {
      stateName = 'failed';
      transcript = null;
      failure = 'Recording was interrupted before durable completion';
    }
    if (transcript !== null && (typeof transcript !== 'string' ||
        transcript.length > MAX_TRANSCRIPT_CHARACTERS)) {
      throw new Error('CaseManager restore saved transcript is invalid');
    }
    if (stateName === 'saved' ? typeof transcript !== 'string' : transcript !== null) {
      throw new Error('CaseManager restore saved transcript is invalid');
    }
    if (failure !== null && (typeof failure !== 'string' || failure.length === 0 ||
        failure.length > MAX_FAILURE_CHARACTERS)) {
      throw new Error('CaseManager restore failure is invalid');
    }
    if (stateName === 'failed' ? typeof failure !== 'string' : failure !== null) {
      throw new Error('CaseManager restore failure is invalid');
    }
    if ((stateName === 'queued' || stateName === 'transcribing') && transcript !== null) {
      throw new Error('CaseManager restore pending transcript is invalid');
    }
    segments.set(meta.segmentId, {
      ...meta,
      chunks: new Map(),
      receivedBytes: 0,
      state: stateName,
      pcm: null,
      audioReleased: true,
      transcript,
      failure
    });
  }

  for (const record of cases.values()) {
    for (const segmentId of [...record.speakers.A, ...record.speakers.B]) {
      if (!segments.has(segmentId)) throw new Error('CaseManager restore case references an unknown segment');
    }
  }

  const currentCases = new Map();
  for (const pair of state.currentCases) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('CaseManager restore current case is invalid');
    const [deviceId, caseId] = pair;
    assertIdentifier(deviceId, 'deviceId');
    assertIdentifier(caseId, 'caseId');
    const caseRecord = cases.get(caseId);
    if (!caseRecord || caseRecord.deviceId !== deviceId || currentCases.has(deviceId)) {
      throw new Error('CaseManager restore current case binding is invalid');
    }
    currentCases.set(deviceId, caseId);
  }

  const segmentTombstones = new Map();
  for (const candidate of state.segmentTombstones) {
    const binding = normalizeMeta(candidate);
    const live = segments.get(binding.segmentId);
    if (live && !sameMeta(live, binding)) throw new Error('CaseManager restore tombstone conflicts with a live segment');
    segmentTombstones.delete(binding.segmentId);
    segmentTombstones.set(binding.segmentId, binding);
  }
  return {cases, segments, currentCases, segmentTombstones};
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    throw new TypeError('segment metadata must be an object');
  }
  assertIdentifier(meta.caseId, 'caseId');
  assertIdentifier(meta.segmentId, 'segmentId');
  if (meta.speaker !== 'A' && meta.speaker !== 'B') {
    throw new RangeError('speaker must be A or B');
  }
  assertApprovedPcmFormat(meta.audio);
  return Object.freeze({
    caseId: meta.caseId,
    segmentId: meta.segmentId,
    speaker: meta.speaker,
    audio: Object.freeze({
      sampleRate: meta.audio.sampleRate,
      bits: meta.audio.bits,
      channels: meta.audio.channels
    })
  });
}

function sameMeta(segment, meta) {
  return segment.caseId === meta.caseId &&
    segment.speaker === meta.speaker &&
    segment.audio.sampleRate === meta.audio.sampleRate &&
    segment.audio.bits === meta.audio.bits &&
    segment.audio.channels === meta.audio.channels;
}

function assertIdentifier(value, name) {
  assertProtocolIdentifier(value, name);
}

function assertSequence(sequence) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff) {
    throw new RangeError('audio sequence must be a 16-bit unsigned integer');
  }
}

function assemblePcm(chunks) {
  const pcm = [];
  for (let sequence = 0; sequence < chunks.size; sequence += 1) {
    const chunk = chunks.get(sequence);
    if (!chunk) {
      throw new Error(`missing audio sequence ${sequence}`);
    }
    pcm.push(chunk);
  }
  const assembled = Buffer.concat(pcm);
  assertEvenPcm(assembled);
  return assembled;
}

function assertEvenPcm(pcm) {
  if (pcm.length % 2 !== 0) {
    throw new RangeError('PCM byte length must be even for 16-bit audio');
  }
}

function completedSegment(segment) {
  if (!segment.pcm) {
    throw new Error(`segment ${segment.segmentId} has no assembled PCM or its raw audio was released`);
  }
  return {
    ...snapshotSegment(segment),
    pcm: Buffer.from(segment.pcm)
  };
}

function releaseSegmentAudio(segment) {
  segment.chunks.clear();
  segment.pcm = null;
  segment.audioReleased = true;
}

function snapshotCase(caseRecord, segments) {
  const speakers = {
    A: caseRecord.speakers.A.map((id) => snapshotSegment(segments.get(id))),
    B: caseRecord.speakers.B.map((id) => snapshotSegment(segments.get(id)))
  };
  return {
    deviceId: caseRecord.deviceId,
    caseId: caseRecord.caseId,
    speakers,
    canMediate: canMediate(speakers)
  };
}

function snapshotSegment(segment) {
  return {
    caseId: segment.caseId,
    segmentId: segment.segmentId,
    speaker: segment.speaker,
    audio: {...segment.audio},
    state: segment.state,
    transcript: segment.transcript,
    failure: segment.failure
  };
}

function canMediate(speakers) {
  const allSegments = [...speakers.A, ...speakers.B];
  return !allSegments.some(({state}) => ACTIVE_STATES.has(state)) &&
    ['A', 'B'].every((speaker) => speakers[speaker].some(({state, transcript}) =>
      state === 'saved' && transcript.trim().length > 0));
}
