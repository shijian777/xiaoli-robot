import { assertApprovedPcmFormat } from './audio/wav.mjs';

const ACTIVE_STATES = new Set(['receiving', 'queued', 'transcribing']);
const TERMINAL_STATES = new Set(['saved', 'failed']);

export class CaseManager {
  constructor() {
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

    const caseRecord = {
      deviceId,
      caseId,
      speakers: {A: [], B: []}
    };
    this.cases.set(caseId, caseRecord);
    return snapshotCase(caseRecord, this.segments);
  }

  startSegment(meta) {
    const normalized = normalizeMeta(meta);
    const existing = this.segments.get(normalized.segmentId);
    if (existing) {
      if (!sameMeta(existing, normalized)) {
        throw new Error(`segment ${normalized.segmentId} conflicts with existing metadata`);
      }
      return snapshotSegment(existing);
    }

    const caseRecord = this.#requireCase(normalized.caseId);
    const segment = {
      ...normalized,
      chunks: new Map(),
      state: 'receiving',
      pcm: null,
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

    const expected = segment.chunks.size;
    if (sequence !== expected) {
      throw new Error(`missing audio sequence ${expected}`);
    }
    segment.chunks.set(sequence, Buffer.from(pcm));
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
    return snapshotSegment(segment);
  }

  failSegment(segmentId, failure = 'transcription failed') {
    const segment = this.#requireSegment(segmentId);
    if (typeof failure !== 'string' || failure.length === 0) {
      throw new TypeError('failure must be a non-empty string');
    }
    if (TERMINAL_STATES.has(segment.state)) {
      if (segment.state !== 'failed' || segment.failure !== failure) {
        throw new Error(`segment ${segmentId} cannot change terminal state`);
      }
      return snapshotSegment(segment);
    }
    segment.failure = failure;
    segment.state = 'failed';
    return snapshotSegment(segment);
  }

  snapshot(caseId) {
    return snapshotCase(this.#requireCase(caseId), this.segments);
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
  return {
    caseId: meta.caseId,
    segmentId: meta.segmentId,
    speaker: meta.speaker,
    audio: {
      sampleRate: meta.audio.sampleRate,
      bits: meta.audio.bits,
      channels: meta.audio.channels
    }
  };
}

function sameMeta(segment, meta) {
  return segment.caseId === meta.caseId &&
    segment.speaker === meta.speaker &&
    segment.audio.sampleRate === meta.audio.sampleRate &&
    segment.audio.bits === meta.audio.bits &&
    segment.audio.channels === meta.audio.channels;
}

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
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
    throw new Error(`segment ${segment.segmentId} has no assembled PCM`);
  }
  return {
    ...snapshotSegment(segment),
    pcm: Buffer.from(segment.pcm)
  };
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
