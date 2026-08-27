import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket, {WebSocketServer} from 'ws';
import {CaseManager} from '../src/case-manager.mjs';
import {parsePcmWav} from '../src/audio/wav.mjs';
import {decodeBinaryFrame, encodeBinaryFrame, FrameKind} from '../src/protocol/binary-frame.mjs';
import {createDeviceGateway} from '../src/device-gateway.mjs';
import {startBridge} from '../src/server.mjs';
import {runFakeDevice} from '../scripts/fake-device.mjs';

const audio = {sampleRate: 16000, bits: 16, channels: 1};
const token = 'local-test-device-token';

function control(type, messageId, fields = {}) {
  return {v: 1, type, messageId, ...fields};
}

function streamFrame(kind, sequence, payload, flags = 0) {
  return encodeBinaryFrame({kind, streamType: 2, flags, sequence, payload});
}

function startFrame({messageId, caseId, segmentId, speaker}) {
  return streamFrame(FrameKind.STREAM_START, 0, Buffer.from(JSON.stringify(control('speech.start', messageId, {
    caseId, segmentId, speaker, audio
  }))));
}

function endFrame({messageId, caseId, segmentId, bytes, lastSequence, complete = true}) {
  return streamFrame(FrameKind.STREAM_END, lastSequence, Buffer.from(JSON.stringify(control('speech.end', messageId, {
    caseId, segmentId, bytes, lastSequence, complete
  }))), complete ? 1 : 0);
}

async function openClient(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function inbox(ws) {
  const messages = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const value = isBinary ? Buffer.from(data) : JSON.parse(data.toString('utf8'));
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({value, isBinary});
    else messages.push({value, isBinary});
  });
  ws.on('close', (code, reason) => {
    while (waiters.length) waiters.shift().reject(Object.assign(new Error('socket closed'), {code, reason: reason.toString()}));
  });
  return {
    next(timeoutMs = 2_000) {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const waiter = {resolve, reject};
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for gateway message'));
        }, timeoutMs);
        timer.unref?.();
        waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
        waiter.reject = (error) => { clearTimeout(timer); reject(error); };
      });
    }
  };
}

async function nextJson(channel, type) {
  for (;;) {
    const message = await channel.next();
    if (!message.isBinary && (!type || message.value.type === type)) return message.value;
  }
}

async function authenticate(ws, channel, candidateToken = token, deviceId = 'device-1') {
  ws.send(JSON.stringify(control('hello', 'hello-1', {
    deviceId,
    firmwareVersion: '1.0.0',
    token: candidateToken,
    capabilities: ['recording', 'voice']
  })));
  return nextJson(channel);
}

async function closeClient(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

async function withGateway(run, overrides = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-gateway-test-'));
  const cases = overrides.caseManager ?? new CaseManager();
  const transcripts = [];
  const asrService = overrides.asrService ?? {
    async transcribe(wavPath, {segmentId}) {
      const parsed = parsePcmWav(await readFile(wavPath));
      assert.equal(parsed.sampleRate, 16000);
      await rm(wavPath);
      transcripts.push(segmentId);
      return segmentId.startsWith('a') ? 'A 的陈述' : 'B 的陈述';
    }
  };
  const gateway = createDeviceGateway({
    deviceToken: token,
    tempDir,
    caseManager: cases,
    asrService,
    mediatorService: overrides.mediatorService ?? {async mediate() { throw new Error('unexpected mediation'); }},
    ttsService: overrides.ttsService ?? {async synthesize() { throw new Error('unexpected TTS'); }},
    createMediatorSession: overrides.createMediatorSession ?? (async () => 'mediator-session'),
    logger: {info() {}, warn() {}, error() {}},
    ...overrides.gatewayOptions
  });
  await gateway.listen({host: '127.0.0.1', port: 0});
  const address = gateway.address();
  try {
    await run({gateway, url: `ws://127.0.0.1:${address.port}/device`, tempDir, cases, transcripts});
  } finally {
    await gateway.shutdown({graceMs: 500});
    await rm(tempDir, {recursive: true, force: true});
  }
}

test('rejects the wrong token with 4003 and acknowledges a canonical hello', async () => {
  await withGateway(async ({url}) => {
    const denied = await openClient(url);
    const deniedChannel = inbox(denied);
    denied.send(JSON.stringify(control('hello', 'denied', {
      deviceId: 'device-denied', firmwareVersion: '1.0.0', token: 'wrong-token', capabilities: []
    })));
    const deniedClose = await new Promise((resolve) => denied.once('close', (code) => resolve(code)));
    assert.equal(deniedClose, 4003);

    const ws = await openClient(url);
    const channel = inbox(ws);
    assert.deepEqual(await authenticate(ws, channel), {
      v: 1, type: 'hello.ack', messageId: 'hello-1', deviceId: 'device-1', protocol: 1
    });
    await closeClient(ws);
    void deniedChannel;
  });
});

test('returns the original ACK for a duplicate messageId and applies it once', async () => {
  let starts = 0;
  class CountingCases extends CaseManager {
    startCase(...args) {
      starts += 1;
      return super.startCase(...args);
    }
  }
  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    const message = control('case.start', 'case-message-1', {caseId: 'case-1'});
    ws.send(JSON.stringify(message));
    const first = await nextJson(channel, 'ack');
    ws.send(JSON.stringify(message));
    const second = await nextJson(channel, 'ack');

    assert.deepEqual(second, first);
    assert.equal(starts, 1);
    await closeClient(ws);
  }, {caseManager: new CountingCases()});
});

test('assembles one speech stream, durably ACKs it, and saves one transcript', async () => {
  await withGateway(async ({gateway, url, cases, transcripts}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start-1', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');

    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    ws.send(startFrame({messageId: 'start-a-1', caseId: 'case-1', segmentId: 'a-1', speaker: 'A'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm.subarray(0, 4)));
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 1, pcm.subarray(4)));
    ws.send(endFrame({messageId: 'end-a-1', caseId: 'case-1', segmentId: 'a-1', bytes: pcm.length, lastSequence: 1}));

    const durable = await nextJson(channel, 'ack');
    assert.equal(durable.messageId, 'end-a-1');
    assert.equal(durable.segmentId, 'a-1');
    await nextJson(channel, 'transcript.saved');
    await gateway.waitForIdle();
    assert.equal(cases.snapshot('case-1').speakers.A.length, 1);
    assert.equal(cases.snapshot('case-1').speakers.A[0].transcript, 'A 的陈述');
    assert.deepEqual(transcripts, ['a-1']);
    await closeClient(ws);
  });
});

test('reports audio_sequence_gap and does not transcribe a segment with a missing chunk', async () => {
  await withGateway(async ({gateway, url, cases, transcripts}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start-1', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'start-a-1', caseId: 'case-1', segmentId: 'a-1', speaker: 'A'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0])));
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 2, Buffer.from([2, 0])));

    const error = await nextJson(channel, 'error');
    assert.equal(error.code, 'audio_sequence_gap');
    await gateway.waitForIdle();
    assert.deepEqual(transcripts, []);
    assert.equal(cases.snapshot('case-1').speakers.A[0].state, 'failed');
    await closeClient(ws);
  });
});

test('rejects mediation until queued transcription has saved both A and B', async () => {
  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start-1', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    ws.send(JSON.stringify(control('mediate.request', 'mediate-1', {caseId: 'case-1'})));

    const error = await nextJson(channel, 'error');
    assert.equal(error.code, 'mediation_not_ready');
    assert.equal(error.retryable, true);
    await closeClient(ws);
  });
});

test('serializes ASR, replays the original segment ACK, and streams canonical TTS PCM in 4096-byte chunks', async () => {
  const asrCalls = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const mediation = {
    conflictSummary: '双方对安排有分歧。',
    aPosition: 'A 希望提前计划。',
    bPosition: 'B 希望保留弹性。',
    aCanImprove: 'A 可以说明优先级。',
    bCanImprove: 'B 可以主动确认时间。',
    commonGround: '双方都希望顺利完成。',
    suggestions: ['共同列出时间表。'],
    spokenText: '请共同列出时间表，并确认各自最重要的安排。'
  };
  let mediationCalls = 0;
  let ttsCalls = 0;
  const voice = Buffer.alloc(9000, 7);
  const asrService = {
    async transcribe(wavPath, {segmentId}) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      asrCalls.push(segmentId);
      if (segmentId === 'a-1') await firstBlocked;
      await readFile(wavPath);
      await rm(wavPath);
      active -= 1;
      return segmentId === 'a-1' ? 'A 的陈述' : 'B 的陈述';
    }
  };
  await withGateway(async ({gateway, url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start-1', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');

    for (const [segmentId, speaker] of [['a-1', 'A'], ['b-1', 'B']]) {
      ws.send(startFrame({messageId: `start-${segmentId}`, caseId: 'case-1', segmentId, speaker}));
      await nextJson(channel, 'ack');
      ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
      ws.send(endFrame({messageId: `end-${segmentId}`, caseId: 'case-1', segmentId, bytes: 4, lastSequence: 0}));
      await nextJson(channel, 'ack');
    }
    assert.equal(maxActive, 1);
    releaseFirst();
    await nextJson(channel, 'transcript.saved');
    await nextJson(channel, 'transcript.saved');
    await gateway.waitForIdle();
    assert.equal(maxActive, 1);

    ws.send(startFrame({messageId: 'replay-start-a-1', caseId: 'case-1', segmentId: 'a-1', speaker: 'A'}));
    const replay = await nextJson(channel, 'ack');
    assert.equal(replay.messageId, 'end-a-1');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    ws.send(endFrame({messageId: 'replay-end-a-1', caseId: 'case-1', segmentId: 'a-1', bytes: 4, lastSequence: 0}));
    assert.deepEqual(await nextJson(channel, 'ack'), replay);

    ws.send(JSON.stringify(control('mediate.request', 'mediate-1', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    const chunks = [];
    let audioStart;
    for (;;) {
      const message = await channel.next();
      if (message.isBinary) {
        const frame = decodeBinaryFrame(message.value);
        assert.equal(frame.kind, FrameKind.STREAM_CHUNK);
        assert.equal(frame.streamType, 0);
        assert.ok(frame.payload.length <= 4096);
        assert.equal(frame.sequence, chunks.length);
        chunks.push(frame.payload);
      } else if (message.value.type === 'audio.start') {
        audioStart = message.value;
      } else if (message.value.type === 'audio.end') {
        break;
      } else if (message.value.type === 'error') {
        assert.fail(`unexpected gateway error: ${message.value.code}`);
      }
    }
    assert.deepEqual(audioStart.audio, audio);
    assert.deepEqual(Buffer.concat(chunks), voice);
    assert.deepEqual(asrCalls, ['a-1', 'b-1']);
    assert.equal(mediationCalls, 1);
    assert.equal(ttsCalls, 1);
    assert.equal((await nextJson(channel, 'state')).state, 'waiting');
    await closeClient(ws);
  }, {
    asrService,
    mediatorService: {async mediate() { mediationCalls += 1; return mediation; }},
    ttsService: {async synthesize(text) { ttsCalls += 1; assert.equal(text, mediation.spokenText); return voice; }}
  });
});

async function startMockAgentStack() {
  const calls = {sessions: [], turns: [], active: 0, maxActive: 0};
  const mediation = {
    conflictSummary: '双方对时间安排有不同想法。',
    aPosition: 'A 希望提前确定。',
    bPosition: 'B 希望保留灵活性。',
    aCanImprove: 'A 可以解释优先事项。',
    bCanImprove: 'B 可以主动提出可选时间。',
    commonGround: '双方都希望安排顺利。',
    suggestions: ['列出两个都可接受的时间。'],
    spokenText: '请列出两个都可接受的时间，再共同确认最终安排。'
  };
  let asrNumber = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(request.headers.authorization, 'Bearer local-mock-uak');
    assert.equal(request.headers['x-agent9-project-id'], 'mock-project');

    if (request.method === 'POST' && request.url === '/api/sessions') {
      const input = JSON.parse(body.toString('utf8'));
      calls.sessions.push(input.agentId);
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({sessionId: input.agentId === 'asr-agent' ? 'asr-session' : 'mediator-session'}));
      return;
    }
    if (request.method === 'POST' && /^\/api\/sessions\/[^/]+\/turns$/.test(request.url)) {
      const sessionId = request.url.split('/')[3];
      calls.active += 1;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      const isAsr = sessionId === 'asr-session';
      calls.turns.push(isAsr ? `asr-${++asrNumber}` : 'mediator');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const assistantMessage = isAsr
        ? JSON.stringify({transcript: asrNumber === 1 ? 'A 的本地模拟陈述' : 'B 的本地模拟陈述', unclear: false})
        : JSON.stringify(mediation);
      response.writeHead(200, {'content-type': 'application/x-ndjson'});
      response.end(`${JSON.stringify({type: 'assistant_message', message: assistantMessage})}\n${JSON.stringify({type: 'turn_finished', payload: {status: 'succeeded'}})}\n`);
      calls.active -= 1;
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    calls,
    mediation,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('runs Bridge and the fake device through a local mock Agent Stack vertical slice', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-vertical-test-'));
  const mock = await startMockAgentStack();
  const outputPath = path.join(directory, 'fake-device-result.wav');
  const voice = Buffer.alloc(10_000);
  for (let offset = 0; offset < voice.length; offset += 2) voice.writeInt16LE((offset * 17) % 32767, offset);
  const advertised = [];
  let serviceStopped = false;
  let bonjourDestroyed = false;
  const bonjour = {
    publish(options) {
      advertised.push(options);
      return {stop(callback) { serviceStopped = true; callback?.(); }};
    },
    destroy(callback) { bonjourDestroyed = true; callback?.(); }
  };
  let bridge;
  try {
    bridge = await startBridge({
      config: {
        baseUrl: mock.baseUrl,
        uak: 'local-mock-uak',
        projectId: 'mock-project',
        asrAgentId: 'asr-agent',
        mediatorAgentId: 'mediator-agent',
        deviceToken: token,
        host: '127.0.0.1',
        port: 0,
        sampleRate: 16000,
        bits: 16,
        channels: 1,
        pythonBin: 'python',
        whisperModel: 'small',
        tempDir: directory
      },
      ttsService: {async synthesize(text) { assert.equal(text, mock.mediation.spokenText); return voice; }},
      bonjourFactory: () => bonjour,
      logger: {info() {}, warn() {}, error() {}}
    });
    const result = await runFakeDevice({
      url: `ws://127.0.0.1:${bridge.address.port}/device`,
      token,
      outputPath
    });

    assert.equal(result.bytes, voice.length);
    assert.deepEqual(parsePcmWav(await readFile(outputPath)).pcm, voice);
    assert.deepEqual(mock.calls.sessions, ['asr-agent', 'mediator-agent']);
    assert.deepEqual(mock.calls.turns, ['asr-1', 'asr-2', 'mediator']);
    assert.equal(mock.calls.maxActive, 1);
    assert.deepEqual(advertised, [{
      name: '小理本机 Bridge',
      type: 'xiaoli',
      protocol: 'tcp',
      port: bridge.address.port,
      txt: {protocol: '1'}
    }]);
  } finally {
    await bridge?.shutdown();
    await mock.close();
    await rm(directory, {recursive: true, force: true});
  }
  assert.equal(serviceStopped, true);
  assert.equal(bonjourDestroyed, true);
});

test('fake device preserves an early transcript event while waiting for the next ACK', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-fake-order-test-'));
  const outputPath = path.join(directory, 'ordered.wav');
  const voice = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const wss = new WebSocketServer({host: '127.0.0.1', port: 0, path: '/device'});
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  wss.on('connection', (ws) => {
    let failsafe;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const message = JSON.parse(data.toString('utf8'));
        if (message.type === 'hello') {
          ws.send(JSON.stringify({v: 1, type: 'hello.ack', messageId: message.messageId, deviceId: message.deviceId, protocol: 1}));
        } else if (message.type === 'case.start') {
          ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true}));
        } else if (message.type === 'mediate.request') {
          clearTimeout(failsafe);
          ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true}));
          ws.send(JSON.stringify({v: 1, type: 'audio.start', caseId: message.caseId, audio, bytes: voice.length}));
          ws.send(encodeBinaryFrame({kind: FrameKind.STREAM_CHUNK, streamType: 0, flags: 0, sequence: 0, payload: voice}));
          ws.send(JSON.stringify({v: 1, type: 'audio.end', caseId: message.caseId, bytes: voice.length, lastSequence: 0, complete: true}));
        }
        return;
      }
      const frame = decodeBinaryFrame(data);
      if (frame.kind === FrameKind.STREAM_START) {
        const message = JSON.parse(frame.payload.toString('utf8'));
        ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, segmentId: message.segmentId, accepted: true}));
      } else if (frame.kind === FrameKind.STREAM_END) {
        const message = JSON.parse(frame.payload.toString('utf8'));
        ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, segmentId: message.segmentId, bytes: message.bytes, durable: true}));
        ws.send(JSON.stringify({v: 1, type: 'transcript.saved', caseId: message.caseId, segmentId: message.segmentId, speaker: message.segmentId.startsWith('a-') ? 'A' : 'B'}));
        if (message.segmentId.startsWith('b-')) failsafe = setTimeout(() => ws.close(1011, 'mediate request not received'), 100);
      }
    });
  });
  const address = wss.address();
  try {
    const result = await runFakeDevice({url: `ws://127.0.0.1:${address.port}/device`, token, outputPath});
    assert.equal(result.bytes, voice.length);
    assert.deepEqual(parsePcmWav(await readFile(outputPath)).pcm, voice);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});
