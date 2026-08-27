import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import WebSocket from 'ws';
import {pcmToWav} from '../src/audio/wav.mjs';
import {decodeBinaryFrame, encodeBinaryFrame, FrameKind} from '../src/protocol/binary-frame.mjs';

const AUDIO = Object.freeze({sampleRate: 16000, bits: 16, channels: 1});
const RECORDING_STREAM = 2;
const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runFakeDevice({
  url = process.env.BRIDGE_DEVICE_URL ?? 'ws://127.0.0.1:8788/device',
  token = process.env.DEVICE_SHARED_TOKEN,
  outputPath = path.join(bridgeRoot, 'tmp', 'fake-device-result.wav')
} = {}) {
  assertNonEmptyString(url, 'url');
  assertNonEmptyString(token, 'DEVICE_SHARED_TOKEN');
  const ws = new WebSocket(url);
  const messages = createInbox(ws);
  const runId = `${Date.now()}-${process.pid}`;
  const caseId = `fake-case-${runId}`;
  const helloMessageId = `hello-${runId}`;
  const caseMessageId = `case-start-${runId}`;
  const segmentIds = {
    A: `a-${runId}`,
    B: `b-${runId}`
  };
  const deadline = setTimeout(() => ws.terminate(), 120_000);
  deadline.unref?.();

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    sendJson(ws, {
      v: 1,
      type: 'hello',
      messageId: helloMessageId,
      deviceId: 'xiaoli-fake-device',
      firmwareVersion: 'fake-1.0.0',
      token,
      capabilities: ['recording', 'voice']
    });
    await waitForJson(messages, (message) => message.type === 'hello.ack' &&
      message.messageId === helloMessageId && message.deviceId === 'xiaoli-fake-device');

    sendJson(ws, {v: 1, type: 'case.start', messageId: caseMessageId, caseId});
    await waitForJson(messages, (message) => message.type === 'ack' &&
      message.messageId === caseMessageId && message.caseId === caseId);

    await sendSegment(ws, messages, {
      runId,
      caseId,
      segmentId: segmentIds.A,
      speaker: 'A',
      pcm: deterministicPcm(330)
    });
    await sendSegment(ws, messages, {
      runId,
      caseId,
      segmentId: segmentIds.B,
      speaker: 'B',
      pcm: deterministicPcm(550)
    });

    const saved = new Set();
    while (saved.size < 2) {
      const message = await waitForJson(messages, (candidate) => candidate.type === 'transcript.saved' &&
        candidate.caseId === caseId && segmentIds[candidate.speaker] === candidate.segmentId);
      saved.add(message.speaker);
    }

    const mediateMessageId = `mediate-${runId}`;
    sendJson(ws, {v: 1, type: 'mediate.request', messageId: mediateMessageId, caseId});
    await waitForJson(messages, (message) => message.type === 'ack' &&
      message.messageId === mediateMessageId && message.caseId === caseId);

    const chunks = [];
    let audioStarted = false;
    for (;;) {
      const incoming = await messages.next();
      if (incoming.isBinary) {
        if (!audioStarted) throw new Error('Bridge sent PCM before audio.start');
        const frame = decodeVoiceChunk(incoming.value, chunks.length);
        chunks.push(frame.payload);
        continue;
      }
      const message = incoming.value;
      if (message.type === 'error') throw new Error(`Bridge error: ${message.code}`);
      if (message.type === 'audio.start' && message.caseId === caseId) {
        audioStarted = true;
        continue;
      }
      if (message.type === 'audio.end' && message.caseId === caseId) break;
    }

    const pcm = Buffer.concat(chunks);
    const wav = pcmToWav(pcm, AUDIO);
    await fs.mkdir(path.dirname(path.resolve(outputPath)), {recursive: true});
    await fs.writeFile(path.resolve(outputPath), wav);
    return {outputPath: path.resolve(outputPath), bytes: pcm.length};
  } finally {
    clearTimeout(deadline);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      const closed = new Promise((resolve) => ws.once('close', resolve));
      ws.close(1000, 'fake device complete');
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 250))]);
    }
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }
}

async function sendSegment(ws, messages, {runId, caseId, segmentId, speaker, pcm}) {
  const startMessageId = `speech-start-${speaker}-${runId}`;
  const start = {
    v: 1,
    type: 'speech.start',
    messageId: startMessageId,
    caseId,
    segmentId,
    speaker,
    audio: AUDIO
  };
  ws.send(frame(FrameKind.STREAM_START, 0, Buffer.from(JSON.stringify(start))));
  await waitForJson(messages, (message) => message.type === 'ack' && message.messageId === startMessageId &&
    message.caseId === caseId && message.segmentId === segmentId);

  let sequence = 0;
  for (let offset = 0; offset < pcm.length; offset += 2048) {
    ws.send(frame(FrameKind.STREAM_CHUNK, sequence, pcm.subarray(offset, offset + 2048)));
    sequence += 1;
  }
  const endMessageId = `speech-end-${speaker}-${runId}`;
  const end = {
    v: 1,
    type: 'speech.end',
    messageId: endMessageId,
    caseId,
    segmentId,
    bytes: pcm.length,
    lastSequence: sequence - 1,
    complete: true
  };
  ws.send(frame(FrameKind.STREAM_END, sequence - 1, Buffer.from(JSON.stringify(end)), 1));
  const ack = await waitForJson(messages, (message) => message.type === 'ack' && message.messageId === endMessageId &&
    message.caseId === caseId && message.segmentId === segmentId);
  if (!ack.durable) throw new Error('Bridge did not durably acknowledge the fake recording');
}

function deterministicPcm(frequency) {
  const samples = 4000;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * index / AUDIO.sampleRate) * 6000);
    pcm.writeInt16LE(sample, index * 2);
  }
  return pcm;
}

function frame(kind, sequence, payload, flags = 0) {
  return encodeBinaryFrame({kind, streamType: RECORDING_STREAM, flags, sequence, payload});
}

function sendJson(ws, message) {
  ws.send(JSON.stringify(message));
}

function createInbox(ws) {
  const queued = [];
  const waiters = [];
  let terminalError;
  const deliver = (incoming) => {
    const index = waiters.findIndex(({predicate}) => predicate(incoming));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(incoming);
    else queued.push(incoming);
  };
  ws.on('message', (data, isBinary) => {
    try {
      deliver({isBinary, value: isBinary ? Buffer.from(data) : JSON.parse(data.toString('utf8'))});
    } catch {
      terminalError = new Error('Bridge sent invalid JSON');
      while (waiters.length) waiters.shift().reject(terminalError);
    }
  });
  ws.on('error', () => {
    terminalError = new Error('Fake device WebSocket failed');
    while (waiters.length) waiters.shift().reject(terminalError);
  });
  ws.on('close', (code) => {
    terminalError ??= new Error(`Bridge closed before audio.end (${code})`);
    while (waiters.length) waiters.shift().reject(terminalError);
  });
  return {
    take(predicate) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => waiters.push({predicate, resolve, reject}));
    },
    next() {
      return this.take(() => true);
    }
  };
}

async function waitForJson(messages, predicate) {
  const incoming = await messages.take((candidate) => candidate.isBinary || candidate.value.type === 'error' || predicate(candidate.value));
  if (incoming.isBinary) throw new Error('Bridge sent PCM before mediation playback');
  if (incoming.value.type === 'error') throw new Error(`Bridge error: ${incoming.value.code}`);
  return incoming.value;
}

function decodeVoiceChunk(payload, expectedSequence) {
  const frame = decodeBinaryFrame(payload);
  if (frame.kind !== FrameKind.STREAM_CHUNK || frame.streamType !== 0 || frame.sequence !== expectedSequence || frame.payload.length > 4096) {
    throw new Error('Bridge sent an invalid voice chunk');
  }
  return frame;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be configured`);
}

async function main() {
  const result = await runFakeDevice();
  console.log(`Fake device wrote ${result.bytes} PCM bytes to ${result.outputPath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error?.message ?? 'Fake device failed');
    process.exitCode = 1;
  });
}
