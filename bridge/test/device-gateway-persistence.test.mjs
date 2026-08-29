import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as realFs from 'node:fs/promises';
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import {CaseManager} from '../src/case-manager.mjs';
import {createDeviceGateway} from '../src/device-gateway.mjs';
import {AtomicJsonStateStore} from '../src/persistence/atomic-json-state-store.mjs';
import {decodeBinaryFrame, encodeBinaryFrame, FrameKind} from '../src/protocol/binary-frame.mjs';
import {startBridge} from '../src/server.mjs';

const token = 'persistent-test-token';
const audio = {sampleRate: 16000, bits: 16, channels: 1};
const SEGMENT_WAV_NAME = /^segment-[0-9a-f-]+\.wav$/i;

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

function endFrame({messageId, caseId, segmentId, bytes = 4, lastSequence = 0, complete = true}) {
  return streamFrame(FrameKind.STREAM_END, lastSequence, Buffer.from(JSON.stringify(control('speech.end', messageId, {
    caseId, segmentId, bytes, lastSequence, complete
  }))), complete ? 1 : 0);
}

function deferred() {
  return Promise.withResolvers();
}

function within(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      timer.unref?.();
    })
  ]);
}

async function waitForPersistedState(tempDir, predicate, timeoutMs = 1_000) {
  const statePath = path.join(tempDir, 'state', 'bridge-state.json');
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const candidate = JSON.parse(await readFile(statePath, 'utf8'));
      if (predicate(candidate)) return candidate;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for persisted state${lastError ? `: ${lastError.message}` : ''}`);
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
    const item = {value: isBinary ? Buffer.from(data) : JSON.parse(data.toString('utf8')), isBinary};
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(item);
    else messages.push(item);
  });
  ws.on('close', (code, reason) => {
    while (waiters.length) waiters.shift().reject(Object.assign(new Error('socket closed'), {
      code, reason: reason.toString()
    }));
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
    let message;
    try {
      message = await channel.next();
    } catch (error) {
      error.message = `${error.message} while waiting for ${type ?? 'JSON'}`;
      throw error;
    }
    if (!message.isBinary && (!type || message.value.type === type)) return message.value;
  }
}

async function authenticate(ws, channel, messageId = 'hello-1') {
  ws.send(JSON.stringify(control('hello', messageId, {
    deviceId: 'device-1', firmwareVersion: '1.0.0', token, capabilities: ['recording', 'voice']
  })));
  return nextJson(channel, 'hello.ack');
}

async function closeClient(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

function gatewayOptions(tempDir, overrides = {}) {
  return {
    deviceToken: token,
    tempDir,
    asrService: overrides.asrService ?? {async transcribe() { return '已恢复陈述'; }},
    mediatorService: overrides.mediatorService ?? {async mediate() { throw new Error('unexpected mediation'); }},
    ttsService: overrides.ttsService ?? {async synthesize() { throw new Error('unexpected TTS'); }},
    createMediatorSession: overrides.createMediatorSession ?? (async () => 'session-1'),
    logger: {info() {}, warn() {}, error() {}},
    ...overrides.gatewayOptions
  };
}

function caseOnlyPersistentState({
  deviceId = 'device-1', caseId = 'case-1', messageId = 'case-start', ackMessageId = messageId
} = {}) {
  const cases = new CaseManager();
  cases.startCase(deviceId, caseId);
  return {
    version: 1,
    caseManager: cases.exportState(),
    devices: [{
      deviceId, currentCaseId: caseId, lastTouchedAt: 0,
      acks: [{
        messageId,
        ack: {v: 1, type: 'ack', messageId: ackMessageId, caseId, accepted: true},
        fingerprint: '0'.repeat(64), binding: null
      }],
      segmentAcks: [], segmentJobs: [], pendingMediation: null
    }]
  };
}

function transcribingPersistentState(bytes) {
  const cases = new CaseManager();
  const meta = {caseId: 'case-1', segmentId: 'a-1', speaker: 'A', audio};
  cases.startCase('device-1', 'case-1');
  cases.startSegment(meta);
  cases.appendChunk('a-1', 0, Buffer.from([1, 0]));
  cases.endSegment('a-1');
  cases.releaseAudio('a-1');
  cases.beginTranscription('a-1');
  const ack = {
    v: 1, type: 'ack', messageId: 'end-a-1', caseId: 'case-1',
    segmentId: 'a-1', bytes, durable: true
  };
  return {
    version: 1,
    caseManager: cases.exportState(),
    devices: [{
      deviceId: 'device-1', currentCaseId: 'case-1', lastTouchedAt: 0,
      acks: [{
        messageId: 'end-a-1', ack, fingerprint: '0'.repeat(64), binding: meta
      }],
      segmentAcks: [{segmentId: 'a-1', ack, meta}],
      segmentJobs: [{
        meta, audioFile: 'segment-123e4567-e89b-12d3-a456-426614174000.wav',
        bytes, status: 'transcribing', notificationPending: false
      }],
      pendingMediation: null
    }]
  };
}

function mediationReadyCases(deviceId = 'device-1', caseId = 'case-1') {
  const cases = new CaseManager();
  cases.startCase(deviceId, caseId);
  for (const [segmentId, speaker] of [[`${caseId}-a`, 'A'], [`${caseId}-b`, 'B']]) {
    cases.startSegment({caseId, segmentId, speaker, audio});
    cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
    cases.endSegment(segmentId);
    cases.saveTranscript(segmentId, `${speaker} 陈述`);
  }
  return cases;
}

function validMediation(spokenText = '请共同确认下一步。') {
  return {
    conflictSummary: '双方对安排有分歧。',
    aPosition: 'A 希望提前安排。',
    bPosition: 'B 希望保留弹性。',
    aCanImprove: 'A 可以说明优先级。',
    bCanImprove: 'B 可以及时回应。',
    commonGround: '双方都希望解决问题。',
    suggestions: ['共同确认下一步。'],
    spokenText
  };
}

async function listenGateway(tempDir, overrides = {}) {
  const gateway = createDeviceGateway(gatewayOptions(tempDir, overrides));
  await gateway.listen({host: '127.0.0.1', port: 0});
  return {gateway, url: `ws://127.0.0.1:${gateway.address().port}/device`};
}

async function recordOne(ws, channel, {caseId, segmentId, speaker}) {
  const start = startFrame({messageId: `start-${segmentId}`, caseId, segmentId, speaker});
  const end = endFrame({messageId: `end-${segmentId}`, caseId, segmentId});
  ws.send(start);
  await nextJson(channel, 'ack');
  ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
  ws.send(end);
  return {start, end, durableAck: await nextJson(channel, 'ack')};
}

test('does not publish a durable speech ACK until the WAV job and ACK ledger state commit finishes', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-ack-'));
  const commitStarted = deferred();
  const releaseCommit = deferred();
  const durabilityEvents = [];
  let snapshot;
  const stateStore = {
    stateDir: path.join(tempDir, 'state'),
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) {
      snapshot = structuredClone(candidate);
      const hasQueuedJob = candidate.devices?.some((device) => device.segmentJobs?.length > 0);
      if (hasQueuedJob) {
        assert.deepEqual(durabilityEvents.slice(-2), ['wav.rename', 'wav.parent.fsync']);
        commitStarted.resolve();
        await releaseCommit.promise;
      }
    }
  };
  const fileSystem = {
    ...realFs,
    async open(candidate, flags, mode) {
      const handle = await realFs.open(candidate, flags, mode);
      if (path.resolve(candidate) !== path.resolve(tempDir)) return handle;
      return {
        async sync() {
          durabilityEvents.push('wav.parent.fsync');
          return handle.sync();
        },
        close: (...args) => handle.close(...args)
      };
    },
    async rename(source, destination) {
      const result = await realFs.rename(source, destination);
      if (String(destination).endsWith('.wav')) durabilityEvents.push('wav.rename');
      return result;
    }
  };
  const {gateway, url} = await listenGateway(tempDir, {
    asrService: {async transcribe() { return new Promise(() => {}); }},
    gatewayOptions: {fileSystem, stateStore}
  });
  try {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'start-a', caseId: 'case-1', segmentId: 'a-1', speaker: 'A'}));
    await nextJson(channel, 'ack');
    await nextJson(channel, 'state');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    ws.send(endFrame({messageId: 'end-a', caseId: 'case-1', segmentId: 'a-1'}));

    await commitStarted.promise;
    await assert.rejects(() => channel.next(30), /timed out/);
    assert.equal(snapshot.devices[0].segmentJobs[0].status, 'queued');
    assert.equal(snapshot.devices[0].segmentJobs[0].bytes, 4);
    assert.equal(snapshot.devices[0].acks.some(({messageId}) => messageId === 'end-a'), true);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    releaseCommit.resolve();
    assert.equal((await nextJson(channel, 'ack')).durable, true);
    await closeClient(ws);
  } finally {
    releaseCommit.resolve();
    await gateway.shutdown({graceMs: 0, cancelGraceMs: 0});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('loads persistent state only once and honors an injected independent state directory', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-once-'));
  const explicitStateDir = path.join(tempDir, 'independent-state');
  let loads = 0;
  const stateStore = {
    stateDir: explicitStateDir,
    async cleanupParts() {},
    async load() { loads += 1; return null; },
    async commit() {}
  };
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    gatewayOptions: {stateDir: explicitStateDir, stateStore}
  }));
  try {
    await gateway.listen({host: '127.0.0.1', port: 0});
    assert.equal(loads, 1);
    await assert.rejects(() => gateway.listen({host: '127.0.0.1', port: 0}), /already listening/);
    assert.equal(loads, 1);
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('accepts 71-byte persistent keys and rejects oversized or mismatched ACK ledger identifiers atomically', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-id-bound-'));
  const max = 'i'.repeat(71);
  const oversized = 'i'.repeat(72);
  const accepted = caseOnlyPersistentState({deviceId: max, caseId: max, messageId: max});
  const acceptedCases = new CaseManager();
  const acceptedGateway = createDeviceGateway(gatewayOptions(tempDir, {
    gatewayOptions: {
      caseManager: acceptedCases,
      stateStore: {async cleanupParts() {}, async load() { return accepted; }, async commit() {}}
    }
  }));
  await acceptedGateway.listen({host: '127.0.0.1', port: 0});
  await acceptedGateway.shutdown();

  const invalidStates = [
    caseOnlyPersistentState({messageId: oversized}),
    caseOnlyPersistentState({ackMessageId: oversized}),
    caseOnlyPersistentState({messageId: 'ledger-key', ackMessageId: 'different-ack-id'})
  ];
  try {
    for (const state of invalidStates) {
      const liveCases = new CaseManager();
      liveCases.startCase('live-device', 'live-case');
      const gateway = createDeviceGateway(gatewayOptions(tempDir, {
        gatewayOptions: {
          caseManager: liveCases,
          stateStore: {async cleanupParts() {}, async load() { return state; }, async commit() {}}
        }
      }));
      try {
        await assert.rejects(() => gateway.listen({host: '127.0.0.1', port: 0}), /identifier|ACK|ledger|invalid/i);
        assert.equal(liveCases.currentCaseId('live-device'), 'live-case');
      } finally {
        await gateway.shutdown();
      }
    }
  } finally {
    await acceptedGateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('rejects persisted segment byte counts above the ten-minute PCM limit', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-byte-bound-'));
  const state = transcribingPersistentState(19_200_001);
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    gatewayOptions: {
      stateStore: {async cleanupParts() {}, async load() { return state; }, async commit() {}}
    }
  }));
  try {
    await assert.rejects(() => gateway.listen({host: '127.0.0.1', port: 0}), /bytes|limit|invalid/i);
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('an oversized on-disk state is rejected before read and cannot replace a live CaseManager', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-oversized-live-'));
  const stateDir = path.join(tempDir, 'state');
  const statePath = path.join(stateDir, 'bridge-state.json');
  let stateRead = false;
  const fileSystem = {
    ...realFs,
    async lstat(candidate) {
      if (path.resolve(candidate) === path.resolve(statePath)) {
        return {size: 1024 * 1024 * 1024, isFile: () => true, isSymbolicLink: () => false};
      }
      return realFs.lstat(candidate);
    },
    async readFile(...args) {
      if (path.resolve(args[0]) === path.resolve(statePath)) stateRead = true;
      return realFs.readFile(...args);
    }
  };
  const liveCases = new CaseManager();
  liveCases.startCase('live-device', 'live-case');
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    gatewayOptions: {caseManager: liveCases, fileSystem, stateDir}
  }));
  try {
    await assert.rejects(() => gateway.listen({host: '127.0.0.1', port: 0}), /state.*(?:large|limit|size)/i);
    assert.equal(stateRead, false);
    assert.equal(liveCases.currentCaseId('live-device'), 'live-case');
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('bounds each persisted device ACK ledger while retaining its most recent exact ACKs', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-ack-bound-'));
  let snapshot;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) { snapshot = structuredClone(candidate); }
  };
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    gatewayOptions: {stateStore}
  }));
  await gateway.listen({host: '127.0.0.1', port: 0});
  try {
    const ws = await openClient(`ws://127.0.0.1:${gateway.address().port}/device`);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    for (let index = 0; index < 520; index += 1) {
      ws.send(JSON.stringify(control('case.start', `case-start-${index}`, {caseId: 'bounded-case'})));
      await nextJson(channel, 'ack');
    }
    const ledger = snapshot.devices.find(({deviceId}) => deviceId === 'device-1').acks;
    assert.equal(ledger.length, 512);
    assert.equal(ledger.some(({messageId}) => messageId === 'case-start-0'), false);
    assert.equal(ledger.some(({messageId}) => messageId === 'case-start-519'), true);
    await closeClient(ws);
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('ACK pruning preserves durable segment bindings so the bounded snapshot remains restartable', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-protected-ack-'));
  let snapshot;
  const firstStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) { snapshot = structuredClone(candidate); }
  };
  const first = await listenGateway(tempDir, {gatewayOptions: {stateStore: firstStore}});
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    const segmentReplay = await recordOne(ws, channel, {
      caseId: 'case-1', segmentId: 'a-1', speaker: 'A'
    });
    await nextJson(channel, 'transcript.saved');
    for (let index = 0; index < 520; index += 1) {
      ws.send(JSON.stringify(control('case.start', `filler-${index}`, {caseId: 'case-1'})));
      await nextJson(channel, 'ack');
    }
    const ledger = snapshot.devices[0].acks;
    assert.equal(ledger.length, 512);
    assert.equal(ledger.some(({messageId}) => messageId === 'start-a-1'), true);
    assert.equal(ledger.some(({messageId}) => messageId === 'end-a-1'), true);
    await closeClient(ws);
    await first.gateway.shutdown();

    const secondStore = {
      async cleanupParts() {},
      async load() { return structuredClone(snapshot); },
      async commit(candidate) { snapshot = structuredClone(candidate); }
    };
    const second = await listenGateway(tempDir, {gatewayOptions: {stateStore: secondStore}});
    try {
      const replay = await openClient(second.url);
      const replayChannel = inbox(replay);
      await authenticate(replay, replayChannel, 'hello-2');
      replay.send(segmentReplay.start);
      assert.equal((await nextJson(replayChannel, 'ack')).accepted, true);
      replay.send(segmentReplay.end);
      assert.equal((await nextJson(replayChannel, 'ack')).durable, true);
      await closeClient(replay);
    } finally {
      await second.gateway.shutdown();
    }
  } finally {
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('prunes disconnected case-free devices before the persistent device map exceeds its fixed cap', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-device-bound-'));
  let snapshot;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) { snapshot = structuredClone(candidate); }
  };
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    gatewayOptions: {stateStore}
  }));
  await gateway.listen({host: '127.0.0.1', port: 0});
  try {
    const url = `ws://127.0.0.1:${gateway.address().port}/device`;
    for (let index = 0; index < 129; index += 1) {
      const ws = await openClient(url);
      const channel = inbox(ws);
      ws.send(JSON.stringify(control('hello', `hello-${index}`, {
        deviceId: `device-${index}`, firmwareVersion: '1.0.0', token,
        capabilities: ['recording', 'voice']
      })));
      await nextJson(channel, 'hello.ack');
      await closeClient(ws);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(snapshot.devices.length <= 128);
    assert.equal(snapshot.devices.some(({deviceId}) => deviceId === 'device-128'), true);
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('a failed case state commit halts without persisting an unacknowledged case during shutdown', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-case-failure-'));
  let failed = false;
  let committed;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) {
      if (!failed && candidate.devices.some((device) =>
        device.acks.some(({messageId}) => messageId === 'case-fail'))) {
        failed = true;
        throw Object.assign(new Error('injected state failure'), {code: 'EIO'});
      }
      committed = structuredClone(candidate);
    }
  };
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {gatewayOptions: {stateStore}}));
  await gateway.listen({host: '127.0.0.1', port: 0});
  try {
    const ws = await openClient(`ws://127.0.0.1:${gateway.address().port}/device`);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    const request = JSON.stringify(control('case.start', 'case-fail', {caseId: 'case-1'}));
    ws.send(request);
    const error = await nextJson(channel, 'error');
    assert.equal(error.code, 'state_persistence_failed');
    assert.equal(error.retryable, true);
    await gateway.shutdown();
    assert.equal(committed.devices[0].acks.some(({messageId}) => messageId === 'case-fail'), false);
    assert.equal(committed.caseManager.cases.some(({caseId}) => caseId === 'case-1'), false);
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('a failed mediation state commit rolls back its ACK and retries the same request exactly once', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-mediate-failure-'));
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  for (const [segmentId, speaker] of [['a-1', 'A'], ['b-1', 'B']]) {
    cases.startSegment({caseId: 'case-1', segmentId, speaker, audio});
    cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
    cases.endSegment(segmentId);
    cases.saveTranscript(segmentId, `${speaker} 陈述`);
  }
  let failed = false;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) {
      if (!failed && candidate.devices.some(({pendingMediation}) =>
        pendingMediation?.messageId === 'mediate-fail')) {
        failed = true;
        throw Object.assign(new Error('injected state failure'), {code: 'EIO'});
      }
    }
  };
  const result = {
    conflictSummary: '双方有分歧。', aPosition: 'A 的立场。', bPosition: 'B 的立场。',
    aCanImprove: 'A 可改进。', bCanImprove: 'B 可改进。', commonGround: '存在共同点。',
    suggestions: ['继续沟通。'], spokenText: '请继续沟通。'
  };
  let mediationCalls = 0;
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    mediatorService: {async mediate() { mediationCalls += 1; return result; }},
    ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
    gatewayOptions: {stateStore, caseManager: cases}
  }));
  await gateway.listen({host: '127.0.0.1', port: 0});
  try {
    const ws = await openClient(`ws://127.0.0.1:${gateway.address().port}/device`);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    const request = JSON.stringify(control('mediate.request', 'mediate-fail', {caseId: 'case-1'}));
    ws.send(request);
    assert.equal((await nextJson(channel, 'error')).code, 'state_persistence_failed');
    assert.equal(mediationCalls, 0);
    ws.send(request);
    assert.equal((await nextJson(channel, 'ack')).messageId, 'mediate-fail');
    await nextJson(channel, 'audio.end');
    assert.equal(mediationCalls, 1);
    await closeClient(ws);
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('a post-rename mediation commit failure halts without rolling back the visible pending request', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-post-rename-'));
  const stateDir = path.join(tempDir, 'state');
  const fatalReported = deferred();
  let failNextDirectorySync = false;
  const fileSystem = {
    ...realFs,
    async open(candidate, flags, mode) {
      const handle = await realFs.open(candidate, flags, mode);
      if (path.resolve(candidate) !== path.resolve(stateDir)) return handle;
      return {
        async sync() {
          if (failNextDirectorySync) {
            failNextDirectorySync = false;
            throw Object.assign(new Error('injected post-rename fsync failure'), {code: 'EIO'});
          }
          return handle.sync();
        },
        close: (...args) => handle.close(...args)
      };
    }
  };
  let mediationCalls = 0;
  const mediatorService = {async mediate() {
    mediationCalls += 1;
    return validMediation();
  }};
  let first;
  let second;
  try {
    first = await listenGateway(tempDir, {
      mediatorService,
      ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
      gatewayOptions: {
        caseManager: mediationReadyCases(),
        fileSystem,
        stateDir,
        onFatal(error) { fatalReported.resolve(error); }
      }
    });
    const initial = await openClient(first.url);
    const initialChannel = inbox(initial);
    await authenticate(initial, initialChannel);
    initial.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(initialChannel, 'ack');

    failNextDirectorySync = true;
    initial.send(JSON.stringify(control('mediate.request', 'mediate-visible', {caseId: 'case-1'})));
    const fatal = await within(fatalReported.promise, 1_000, 'post-rename persistence fatal');
    assert.equal(fatal.commitPhase, 'post-rename');
    assert.equal(fatal.stateMayBeVisible, true);
    assert.equal(mediationCalls, 0);
    await first.gateway.shutdown();

    const visibleState = JSON.parse(await readFile(
      path.join(stateDir, 'bridge-state.json'), 'utf8'));
    assert.equal(visibleState.devices[0].pendingMediation.messageId, 'mediate-visible');
    assert.equal(visibleState.devices[0].acks.some(
      ({messageId}) => messageId === 'mediate-visible'), true);

    second = await listenGateway(tempDir, {
      mediatorService,
      ttsService: {async synthesize() { return Buffer.from([1, 0]); }}
    });
    const replay = await openClient(second.url);
    const replayChannel = inbox(replay);
    await authenticate(replay, replayChannel, 'hello-2');
    await nextJson(replayChannel, 'audio.end');
    assert.equal(mediationCalls, 1);
    await closeClient(replay);
  } finally {
    await second?.gateway.shutdown().catch(() => {});
    await first?.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('a transcribing state commit failure halts safely with its durable WAV and resumes after restart', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-asr-state-failure-'));
  const backing = new AtomicJsonStateStore({stateDir: path.join(tempDir, 'state')});
  let failed = false;
  let firstProviderCalls = 0;
  const stateStore = {
    cleanupParts: () => backing.cleanupParts(),
    load: () => backing.load(),
    async commit(candidate) {
      if (!failed && candidate.devices.some((device) =>
        device.segmentJobs.some(({status}) => status === 'transcribing'))) {
        failed = true;
        throw Object.assign(new Error('injected state failure'), {code: 'EIO'});
      }
      return backing.commit(candidate);
    }
  };
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe() { firstProviderCalls += 1; return 'must not run'; }},
    gatewayOptions: {stateStore}
  });
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    await recordOne(ws, channel, {caseId: 'case-1', segmentId: 'a-1', speaker: 'A'});
    await first.gateway.shutdown();
    assert.equal(firstProviderCalls, 0);
    assert.equal((await readdir(tempDir)).some((name) => SEGMENT_WAV_NAME.test(name)), true);

    const second = await listenGateway(tempDir, {
      asrService: {async transcribe() { return '重启后完成转写'; }}
    });
    try {
      const replay = await openClient(second.url);
      const replayChannel = inbox(replay);
      await authenticate(replay, replayChannel, 'hello-2');
      assert.equal((await nextJson(replayChannel, 'transcript.saved')).segmentId, 'a-1');
      await closeClient(replay);
    } finally {
      await second.gateway.shutdown();
    }
  } finally {
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('commits a terminal ASR failure before notifying the connected device', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-asr-failed-order-'));
  const provider = deferred();
  const failureCommitStarted = deferred();
  const releaseFailureCommit = deferred();
  let failureSnapshot;
  let heldFailureCommit = false;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) {
      const failedJob = candidate.devices?.flatMap(({segmentJobs}) => segmentJobs)
        .find(({status}) => status === 'failed');
      if (failedJob && !heldFailureCommit) {
        heldFailureCommit = true;
        failureSnapshot = structuredClone(candidate);
        failureCommitStarted.resolve();
        await releaseFailureCommit.promise;
      }
    }
  };
  const {gateway, url} = await listenGateway(tempDir, {
    asrService: {async transcribe() { return provider.promise; }},
    gatewayOptions: {stateStore}
  });
  try {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    await recordOne(ws, channel, {caseId: 'case-1', segmentId: 'a-1', speaker: 'A'});
    await nextJson(channel, 'state');

    provider.reject(new Error('injected ASR failure'));
    await within(failureCommitStarted.promise, 500, 'failed-state commit');
    await assert.rejects(() => channel.next(40), /timed out/);
    assert.equal(failureSnapshot.devices[0].segmentJobs[0].status, 'failed');
    assert.equal(failureSnapshot.devices[0].segmentJobs[0].notificationPending, true);
    assert.equal(failureSnapshot.caseManager.segments[0].state, 'failed');

    releaseFailureCommit.resolve();
    const error = await nextJson(channel, 'error');
    assert.equal(error.code, 'transcription_failed');
    assert.equal(error.caseId, 'case-1');
    assert.equal(error.segmentId, 'a-1');
    assert.equal((await nextJson(channel, 'state')).state, 'waiting');
    assert.equal(await gateway.waitForIdle({timeoutMs: 500}), true);
    await closeClient(ws);
  } finally {
    provider.reject(new Error('test cleanup'));
    releaseFailureCommit.resolve();
    await gateway.shutdown({graceMs: 0, cancelGraceMs: 0});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('retains and replays a durable transcription_failed result until its case is evicted', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-asr-failed-replay-'));
  const provider = deferred();
  const providerStarted = deferred();
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe() {
      providerStarted.resolve();
      return provider.promise;
    }}
  });
  let second;
  let third;
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    const original = await recordOne(ws, channel, {
      caseId: 'case-1', segmentId: 'a-1', speaker: 'A'
    });
    await providerStarted.promise;
    await closeClient(ws);

    provider.reject(new Error('offline ASR failure'));
    assert.equal(await first.gateway.waitForIdle({timeoutMs: 1_000}), true);
    const failedState = JSON.parse(await readFile(
      path.join(tempDir, 'state', 'bridge-state.json'), 'utf8'));
    assert.equal(failedState.devices[0].segmentJobs[0].status, 'failed');
    assert.equal(failedState.devices[0].segmentJobs[0].notificationPending, true);

    // A successful WebSocket send only means that bytes entered the host send
    // buffer.  It must not consume the durable result when the device never
    // reads it.
    const blackHole = await openClient(first.url);
    blackHole._socket.pause();
    blackHole.send(JSON.stringify(control('hello', 'hello-2', {
      deviceId: 'device-1', firmwareVersion: '1.0.0', token,
      capabilities: ['recording', 'voice']
    })));
    await waitForPersistedState(tempDir, (candidate) => candidate.devices?.some((device) =>
      device.acks?.some(({messageId}) => messageId === 'hello-2')));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const blackHoleClosed = new Promise((resolve) => blackHole.once('close', resolve));
    blackHole.terminate();
    await within(blackHoleClosed, 500, 'black-hole socket termination');
    const afterBlackHole = JSON.parse(await readFile(
      path.join(tempDir, 'state', 'bridge-state.json'), 'utf8'));
    assert.deepEqual(afterBlackHole.devices[0].segmentJobs.map(({status, notificationPending}) => ({
      status, notificationPending
    })), [{status: 'failed', notificationPending: true}]);
    await first.gateway.shutdown();

    let restartedAsrCalls = 0;
    second = await listenGateway(tempDir, {
      asrService: {async transcribe() { restartedAsrCalls += 1; return 'must not run'; }}
    });
    const afterRestart = await openClient(second.url);
    const afterRestartChannel = inbox(afterRestart);
    await authenticate(afterRestart, afterRestartChannel, 'hello-3');
    const error = await nextJson(afterRestartChannel, 'error');
    assert.deepEqual({code: error.code, caseId: error.caseId, segmentId: error.segmentId}, {
      code: 'transcription_failed', caseId: 'case-1', segmentId: 'a-1'
    });
    assert.equal((await nextJson(afterRestartChannel, 'state')).state, 'waiting');
    await closeClient(afterRestart);

    const repeated = await openClient(second.url);
    const repeatedChannel = inbox(repeated);
    await authenticate(repeated, repeatedChannel, 'hello-4');
    const repeatedError = await nextJson(repeatedChannel, 'error');
    assert.deepEqual({
      code: repeatedError.code,
      caseId: repeatedError.caseId,
      segmentId: repeatedError.segmentId
    }, {code: 'transcription_failed', caseId: 'case-1', segmentId: 'a-1'});
    assert.equal((await nextJson(repeatedChannel, 'state')).state, 'waiting');

    repeated.send(original.start);
    assert.equal((await nextJson(repeatedChannel, 'ack')).messageId, 'start-a-1');
    repeated.send(original.end);
    const durable = await nextJson(repeatedChannel, 'ack');
    assert.equal(durable.messageId, 'end-a-1');
    assert.equal(durable.durable, true);
    assert.equal(restartedAsrCalls, 0);

    repeated.send(JSON.stringify(control('case.start', 'case-start-2', {caseId: 'case-2'})));
    assert.equal((await nextJson(repeatedChannel, 'ack')).messageId, 'case-start-2');
    assert.equal((await nextJson(repeatedChannel, 'state')).caseId, 'case-2');
    await closeClient(repeated);
    await second.gateway.shutdown();
    second = undefined;

    const evictedState = JSON.parse(await readFile(
      path.join(tempDir, 'state', 'bridge-state.json'), 'utf8'));
    assert.equal(evictedState.devices[0].segmentJobs.length, 0);

    third = await listenGateway(tempDir, {
      asrService: {async transcribe() { restartedAsrCalls += 1; return 'must not run'; }}
    });
    const afterEviction = await openClient(third.url);
    const afterEvictionChannel = inbox(afterEviction);
    await authenticate(afterEviction, afterEvictionChannel, 'hello-5');
    await assert.rejects(() => afterEvictionChannel.next(80), /timed out/);
    assert.equal(restartedAsrCalls, 0);
    await closeClient(afterEviction);
  } finally {
    provider.reject(new Error('test cleanup'));
    await third?.gateway.shutdown().catch(() => {});
    await second?.gateway.shutdown().catch(() => {});
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('startBridge exposes a persistence fatal only after the Gateway has shut down', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-runtime-fatal-'));
  let failed = false;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) {
      if (!failed && candidate.devices.some((device) =>
        device.acks.some(({messageId}) => messageId === 'fatal-case'))) {
        failed = true;
        throw Object.assign(new Error('injected persistence fatal'), {code: 'EIO'});
      }
    }
  };
  const runtime = await startBridge({
    config: {
      baseUrl: 'https://agent-stack.test', uak: 'test-uak', projectId: 'test-project',
      asrAgentId: 'test-asr', mediatorAgentId: 'test-mediator', deviceToken: token,
      host: '127.0.0.1', port: 0, tempDir, stateDir: path.join(tempDir, 'state'),
      mdnsEnabled: false, xfyunRtasr: null
    },
    client: {async createSession() { return 'unused'; }},
    asrService: {async transcribe() { return 'unused'; }},
    mediatorService: {async mediate() { throw new Error('unused'); }},
    ttsService: {async synthesize() { throw new Error('unused'); }},
    gatewayOptions: {stateStore},
    logger: {info() {}, warn() {}, error() {}}
  });
  try {
    const ws = await openClient(`ws://127.0.0.1:${runtime.address.port}/device`);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'fatal-case', {caseId: 'case-1'})));
    assert.equal((await nextJson(channel, 'error')).code, 'state_persistence_failed');

    const fatal = await within(runtime.fatal, 1_000, 'runtime fatal');
    assert.equal(fatal.code, 'EIO');
    assert.throws(() => runtime.gateway.address(), /not listening/);
  } finally {
    await runtime.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('shutdown before listen never overwrites an existing durable Gateway state', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-unrecovered-shutdown-'));
  const asrStarted = deferred();
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe(_wavPath, {signal}) {
      asrStarted.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }}
  });
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    await recordOne(ws, channel, {caseId: 'case-1', segmentId: 'a-1', speaker: 'A'});
    await asrStarted.promise;
    await first.gateway.shutdown({graceMs: 0, cancelGraceMs: 100});
    const statePath = path.join(tempDir, 'state', 'bridge-state.json');
    const before = await readFile(statePath);

    const neverListened = createDeviceGateway(gatewayOptions(tempDir));
    await neverListened.shutdown();
    assert.deepEqual(await readFile(statePath), before);
  } finally {
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('restarts a transcribing job, preserves exact ACK replay, rejects conflicting reuse, and delivers a committed transcript', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-restart-'));
  const firstAsrStarted = deferred();
  let firstAborts = 0;
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe(_wavPath, {signal}) {
      firstAsrStarted.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        firstAborts += 1;
        reject(signal.reason);
      }, {once: true}));
    }}
  });
  let originalAck;
  let exactStart;
  let exactEnd;
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    ({start: exactStart, end: exactEnd, durableAck: originalAck} = await recordOne(ws, channel, {
      caseId: 'case-1', segmentId: 'a-1', speaker: 'A'
    }));
    await firstAsrStarted.promise;
    await first.gateway.shutdown({graceMs: 0, cancelGraceMs: 100});
    assert.equal(firstAborts, 1);

    let recoveredCalls = 0;
    const second = await listenGateway(tempDir, {
      asrService: {async transcribe(wavPath, {segmentId}) {
        recoveredCalls += 1;
        assert.equal(segmentId, 'a-1');
        assert.ok((await readFile(wavPath)).length > 44);
        return 'A 重启后恢复的陈述';
      }}
    });
    try {
      assert.equal(await second.gateway.waitForIdle({timeoutMs: 2_000}), true);
      assert.equal(recoveredCalls, 1);
      assert.deepEqual(
        (await readdir(tempDir)).filter((name) => SEGMENT_WAV_NAME.test(name)),
        []
      );
      await second.gateway.shutdown();

      const third = await listenGateway(tempDir, {
        asrService: {async transcribe() { throw new Error('saved transcript must not be transcribed again'); }}
      });
      const replay = await openClient(third.url);
      const replayChannel = inbox(replay);
      try {
        await authenticate(replay, replayChannel, 'hello-2');
        assert.equal((await nextJson(replayChannel, 'transcript.saved')).segmentId, 'a-1');

        replay.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
        assert.equal((await nextJson(replayChannel, 'ack')).messageId, 'case-start');
        replay.send(exactStart);
        await nextJson(replayChannel, 'ack');
        replay.send(exactEnd);
        assert.deepEqual(await nextJson(replayChannel, 'ack'), originalAck);

        replay.send(endFrame({messageId: 'end-a-1', caseId: 'case-1', segmentId: 'a-1', bytes: 2}));
        assert.equal((await nextJson(replayChannel, 'error')).code, 'message_id_conflict');
        replay.send(startFrame({messageId: 'changed-speaker', caseId: 'case-1', segmentId: 'a-1', speaker: 'B'}));
        assert.equal((await nextJson(replayChannel, 'error')).code, 'segment_conflict');
      } finally {
        await closeClient(replay);
        await third.gateway.shutdown();
      }
    } finally {
      await second.gateway.shutdown();
    }
  } finally {
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('saved A and B transcripts remain mediation-ready after a full Gateway restart', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-mediate-'));
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe(_wavPath, {segmentId}) {
      return segmentId.startsWith('a') ? 'A 已保存陈述' : 'B 已保存陈述';
    }}
  });
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    for (const [segmentId, speaker] of [['a-1', 'A'], ['b-1', 'B']]) {
      await recordOne(ws, channel, {caseId: 'case-1', segmentId, speaker});
      await nextJson(channel, 'transcript.saved');
    }
    await first.gateway.waitForIdle();
    await closeClient(ws);
    await first.gateway.shutdown();

    const mediation = {
      conflictSummary: '双方安排不同。',
      aPosition: 'A 希望提前。',
      bPosition: 'B 希望灵活。',
      aCanImprove: 'A 可说明原因。',
      bCanImprove: 'B 可主动确认。',
      commonGround: '都希望顺利。',
      suggestions: ['共同确认时间。'],
      spokenText: '请先确认共同目标，再约定双方都能做到的下一步。'
    };
    let mediatedSnapshot;
    const voice = Buffer.from([1, 0, 2, 0]);
    const second = await listenGateway(tempDir, {
      mediatorService: {async mediate(snapshot) { mediatedSnapshot = snapshot; return mediation; }},
      ttsService: {async synthesize() { return voice; }}
    });
    try {
      const replay = await openClient(second.url);
      const replayChannel = inbox(replay);
      await authenticate(replay, replayChannel, 'hello-after-restart');
      replay.send(JSON.stringify(control('mediate.request', 'mediate-after-restart', {caseId: 'case-1'})));
      await nextJson(replayChannel, 'ack');
      const chunks = [];
      for (;;) {
        const message = await replayChannel.next();
        if (message.isBinary) chunks.push(decodeBinaryFrame(message.value).payload);
        else if (message.value.type === 'audio.end') break;
        else if (message.value.type === 'error') assert.fail(message.value.code);
      }
      assert.equal(mediatedSnapshot.canMediate, true);
      assert.equal(mediatedSnapshot.speakers.A[0].transcript, 'A 已保存陈述');
      assert.equal(mediatedSnapshot.speakers.B[0].transcript, 'B 已保存陈述');
      assert.deepEqual(Buffer.concat(chunks), voice);
      await closeClient(replay);
    } finally {
      await second.gateway.shutdown();
    }
  } finally {
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('serializes durable mutations so one device cannot persist another device\'s rolled-back request', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-transaction-isolation-'));
  const cases = mediationReadyCases('device-a', 'case-a');
  const rejectedCommitStarted = deferred();
  const releaseRejectedCommit = deferred();
  let tail = Promise.resolve();
  let durableState;
  let rejectedOnce = false;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    commit(candidate) {
      const snapshot = structuredClone(candidate);
      const operation = tail.catch(() => {}).then(async () => {
        if (!rejectedOnce && snapshot.devices.some(({pendingMediation}) =>
          pendingMediation?.messageId === 'mediate-a')) {
          rejectedOnce = true;
          rejectedCommitStarted.resolve();
          await releaseRejectedCommit.promise;
          throw Object.assign(new Error('injected A commit failure'), {code: 'EIO'});
        }
        durableState = snapshot;
      });
      tail = operation;
      return operation;
    }
  };
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    gatewayOptions: {stateStore, caseManager: cases}
  }));
  await gateway.listen({host: '127.0.0.1', port: 0});
  let deviceA;
  let deviceB;
  try {
    const url = `ws://127.0.0.1:${gateway.address().port}/device`;
    deviceA = await openClient(url);
    const channelA = inbox(deviceA);
    deviceA.send(JSON.stringify(control('hello', 'hello-a', {
      deviceId: 'device-a', firmwareVersion: '1.0.0', token, capabilities: []
    })));
    await nextJson(channelA, 'hello.ack');
    deviceA.send(JSON.stringify(control('case.start', 'case-start-a', {caseId: 'case-a'})));
    await nextJson(channelA, 'ack');

    deviceB = await openClient(url);
    const channelB = inbox(deviceB);
    deviceB.send(JSON.stringify(control('hello', 'hello-b', {
      deviceId: 'device-b', firmwareVersion: '1.0.0', token, capabilities: []
    })));
    await nextJson(channelB, 'hello.ack');

    deviceA.send(JSON.stringify(control('mediate.request', 'mediate-a', {caseId: 'case-a'})));
    await within(rejectedCommitStarted.promise, 500, 'device A rejected commit');
    deviceB.send(JSON.stringify(control('case.start', 'case-start-b', {caseId: 'case-b'})));
    // In the broken implementation B snapshots A's tentative mutation here.
    // A correct transaction mutex keeps B outside the mutation boundary until
    // A has failed and rolled back.
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseRejectedCommit.resolve();

    assert.equal((await nextJson(channelA, 'error')).code, 'state_persistence_failed');
    assert.equal((await nextJson(channelB, 'ack')).messageId, 'case-start-b');
    const persistedA = durableState.devices.find(({deviceId}) => deviceId === 'device-a');
    const persistedB = durableState.devices.find(({deviceId}) => deviceId === 'device-b');
    assert.equal(persistedA.pendingMediation, null);
    assert.equal(persistedA.acks.some(({messageId}) => messageId === 'mediate-a'), false);
    assert.equal(persistedB.acks.some(({messageId}) => messageId === 'case-start-b'), true);
  } finally {
    releaseRejectedCommit.resolve();
    await closeClient(deviceA).catch(() => {});
    await closeClient(deviceB).catch(() => {});
    await gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('poisons queued transactions after a fatal case replacement failure and restores the old durable case', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-fatal-transaction-poison-'));
  const cases = mediationReadyCases('device-a', 'case-old');
  const rejectedCommitStarted = deferred();
  const releaseRejectedCommit = deferred();
  const fatalReported = deferred();
  let tail = Promise.resolve();
  let rejectedOnce = false;
  let successfulCommits = 0;
  let durableState;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    commit(candidate) {
      const snapshot = structuredClone(candidate);
      const operation = tail.catch(() => {}).then(async () => {
        if (!rejectedOnce && snapshot.devices.some(({acks}) =>
          acks.some(({messageId}) => messageId === 'replace-a'))) {
          rejectedOnce = true;
          rejectedCommitStarted.resolve();
          await releaseRejectedCommit.promise;
          throw Object.assign(new Error('injected fatal replacement failure'), {code: 'EIO'});
        }
        durableState = snapshot;
        successfulCommits += 1;
      });
      tail = operation;
      return operation;
    }
  };
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    gatewayOptions: {
      stateStore,
      caseManager: cases,
      onFatal(error) { fatalReported.resolve(error); }
    }
  }));
  await gateway.listen({host: '127.0.0.1', port: 0});
  let deviceA;
  let deviceB;
  try {
    const url = `ws://127.0.0.1:${gateway.address().port}/device`;
    deviceA = await openClient(url);
    const channelA = inbox(deviceA);
    deviceA.send(JSON.stringify(control('hello', 'hello-fatal-a', {
      deviceId: 'device-a', firmwareVersion: '1.0.0', token, capabilities: []
    })));
    await nextJson(channelA, 'hello.ack');
    deviceA.send(JSON.stringify(control('case.start', 'case-old-start', {caseId: 'case-old'})));
    await nextJson(channelA, 'ack');

    deviceB = await openClient(url);
    const channelB = inbox(deviceB);
    deviceB.send(JSON.stringify(control('hello', 'hello-fatal-b', {
      deviceId: 'device-b', firmwareVersion: '1.0.0', token, capabilities: []
    })));
    await nextJson(channelB, 'hello.ack');
    const commitsBeforeFailure = successfulCommits;

    deviceA.send(JSON.stringify(control('case.start', 'replace-a', {caseId: 'case-new'})));
    await within(rejectedCommitStarted.promise, 500, 'fatal replacement commit');
    deviceB.send(JSON.stringify(control('case.start', 'queued-b', {caseId: 'case-b'})));
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseRejectedCommit.resolve();

    const fatal = await within(fatalReported.promise, 2_000, 'Gateway fatal callback');
    assert.match(fatal.message, /replacement failure/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(successfulCommits, commitsBeforeFailure);
    assert.equal(cases.currentCaseId('device-a'), 'case-old');
    assert.equal(durableState.caseManager.cases.some(({caseId}) => caseId === 'case-old'), true);
    assert.equal(durableState.caseManager.cases.some(({caseId}) => caseId === 'case-new'), false);
    assert.equal(durableState.caseManager.cases.some(({caseId}) => caseId === 'case-b'), false);
    const oldSegments = durableState.caseManager.segments.filter(({caseId}) => caseId === 'case-old');
    assert.deepEqual(oldSegments.map(({state, transcript}) => ({state, transcript})), [
      {state: 'saved', transcript: 'A 陈述'},
      {state: 'saved', transcript: 'B 陈述'}
    ]);
    const persistedA = durableState.devices.find(({deviceId}) => deviceId === 'device-a');
    const persistedB = durableState.devices.find(({deviceId}) => deviceId === 'device-b');
    assert.equal(persistedA.currentCaseId, 'case-old');
    assert.equal(persistedA.acks.some(({messageId}) => messageId === 'replace-a'), false);
    assert.equal(persistedB.acks.some(({messageId}) => messageId === 'queued-b'), false);
  } finally {
    releaseRejectedCommit.resolve();
    if (deviceA) deviceA.terminate();
    if (deviceB) deviceB.terminate();
    await gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('serializes a failed recording-stop commit before another device snapshots durable state', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-recording-transaction-'));
  const rejectedCommitStarted = deferred();
  const releaseRejectedCommit = deferred();
  let rejectedOnce = false;
  let tail = Promise.resolve();
  let durableState;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    commit(candidate) {
      const snapshot = structuredClone(candidate);
      const operation = tail.catch(() => {}).then(async () => {
        if (!rejectedOnce && snapshot.devices.some(({segmentJobs}) =>
          segmentJobs.some(({meta}) => meta.segmentId === 'recording-a'))) {
          rejectedOnce = true;
          rejectedCommitStarted.resolve();
          await releaseRejectedCommit.promise;
          throw Object.assign(new Error('injected recording commit failure'), {code: 'EIO'});
        }
        durableState = snapshot;
      });
      tail = operation;
      return operation;
    }
  };
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {gatewayOptions: {stateStore}}));
  await gateway.listen({host: '127.0.0.1', port: 0});
  let deviceA;
  let deviceB;
  try {
    const url = `ws://127.0.0.1:${gateway.address().port}/device`;
    deviceA = await openClient(url);
    const channelA = inbox(deviceA);
    deviceA.send(JSON.stringify(control('hello', 'hello-recording-a', {
      deviceId: 'device-a', firmwareVersion: '1.0.0', token, capabilities: []
    })));
    await nextJson(channelA, 'hello.ack');
    deviceA.send(JSON.stringify(control('case.start', 'case-start-a', {caseId: 'case-a'})));
    await nextJson(channelA, 'ack');

    deviceB = await openClient(url);
    const channelB = inbox(deviceB);
    deviceB.send(JSON.stringify(control('hello', 'hello-recording-b', {
      deviceId: 'device-b', firmwareVersion: '1.0.0', token, capabilities: []
    })));
    await nextJson(channelB, 'hello.ack');

    deviceA.send(startFrame({
      messageId: 'start-recording-a', caseId: 'case-a', segmentId: 'recording-a', speaker: 'A'
    }));
    await nextJson(channelA, 'ack');
    deviceA.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    deviceA.send(endFrame({
      messageId: 'end-recording-a', caseId: 'case-a', segmentId: 'recording-a'
    }));
    await within(rejectedCommitStarted.promise, 1_000, 'recording commit');
    deviceB.send(JSON.stringify(control('case.start', 'case-start-b', {caseId: 'case-b'})));
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseRejectedCommit.resolve();

    assert.equal((await nextJson(channelA, 'error')).code, 'audio_write_failed');
    assert.equal((await nextJson(channelB, 'ack')).messageId, 'case-start-b');
    const persistedA = durableState.devices.find(({deviceId}) => deviceId === 'device-a');
    assert.equal(persistedA.segmentJobs.length, 0);
    assert.equal(persistedA.segmentAcks.length, 0);
    assert.equal(persistedA.acks.some(({messageId}) => messageId === 'end-recording-a'), false);
  } finally {
    releaseRejectedCommit.resolve();
    if (deviceA) await closeClient(deviceA).catch(() => {});
    if (deviceB) await closeClient(deviceB).catch(() => {});
    await gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('a mediation ACK persists its pending job and automatically resumes playback after restart', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-mediation-job-'));
  const mediationStarted = deferred();
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe(_wavPath, {segmentId}) { return `${segmentId} 陈述`; }},
    mediatorService: {async mediate(_snapshot, _sessionId, {signal}) {
      mediationStarted.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }}
  });
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    for (const [segmentId, speaker] of [['a-1', 'A'], ['b-1', 'B']]) {
      await recordOne(ws, channel, {caseId: 'case-1', segmentId, speaker});
      await nextJson(channel, 'transcript.saved');
    }
    ws.send(JSON.stringify(control('mediate.request', 'mediate-1', {caseId: 'case-1'})));
    assert.equal((await nextJson(channel, 'ack')).messageId, 'mediate-1');
    await mediationStarted.promise;
    await first.gateway.shutdown({graceMs: 0, cancelGraceMs: 100});

    const result = {
      conflictSummary: '双方对安排有分歧。',
      aPosition: 'A 希望提前安排。',
      bPosition: 'B 希望保留弹性。',
      aCanImprove: 'A 可以说明优先级。',
      bCanImprove: 'B 可以及时回应。',
      commonGround: '双方都希望解决问题。',
      suggestions: ['共同确认下一步。'],
      spokenText: '请共同确认下一步。'
    };
    const voice = Buffer.from([9, 0, 8, 0]);
    let mediationCalls = 0;
    const second = await listenGateway(tempDir, {
      mediatorService: {async mediate() { mediationCalls += 1; return result; }},
      ttsService: {async synthesize() { return voice; }}
    });
    try {
      const replay = await openClient(second.url);
      const replayChannel = inbox(replay);
      await authenticate(replay, replayChannel, 'hello-2');
      const chunks = [];
      for (;;) {
        const message = await replayChannel.next();
        if (message.isBinary) chunks.push(decodeBinaryFrame(message.value).payload);
        else if (message.value.type === 'audio.end') break;
        else if (message.value.type === 'error') assert.fail(message.value.code);
      }
      assert.equal(mediationCalls, 1);
      assert.deepEqual(Buffer.concat(chunks), voice);
      await closeClient(replay);
    } finally {
      await second.gateway.shutdown();
    }
  } finally {
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('a mobile retry before the reconnect resume timer fires restarts the durable pending mediation', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-mobile-retry-'));
  const mediationStarted = deferred();
  const first = await listenGateway(tempDir, {
    mediatorService: {async mediate(_snapshot, _sessionId, {signal}) {
      mediationStarted.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    }},
    gatewayOptions: {caseManager: mediationReadyCases()}
  });
  let second;
  try {
    const initial = await openClient(first.url);
    const initialChannel = inbox(initial);
    await authenticate(initial, initialChannel);
    const admitted = await first.gateway.requestMobileMediation('device-1');
    await within(mediationStarted.promise, 1_000, 'initial mediation');
    await first.gateway.shutdown({graceMs: 0, cancelGraceMs: 100});

    second = await listenGateway(tempDir, {
      mediatorService: {async mediate() { return validMediation(); }},
      ttsService: {async synthesize() { return Buffer.from([9, 0, 8, 0]); }}
    });
    const replay = await openClient(second.url);
    const replayChannel = inbox(replay);
    await authenticate(replay, replayChannel, 'hello-2');

    const retried = await second.gateway.requestMobileMediation('device-1');
    assert.deepEqual(retried, admitted);
    await within(nextJson(replayChannel, 'audio.end'), 1_000, 'reused pending mediation playback');
    await closeClient(replay);
  } finally {
    await first.gateway.shutdown().catch(() => {});
    await second?.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('an exhausted mediation request stays terminal across restart until a new request arrives', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-mediation-terminal-'));
  let mediationCalls = 0;
  const mediatorService = {async mediate() {
    mediationCalls += 1;
    if (mediationCalls <= 2) throw new Error('bounded provider failure');
    return validMediation();
  }};
  let first;
  let second;
  try {
    first = await listenGateway(tempDir, {
      mediatorService,
      ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
      gatewayOptions: {caseManager: mediationReadyCases()}
    });
    const initial = await openClient(first.url);
    const initialChannel = inbox(initial);
    await authenticate(initial, initialChannel);
    initial.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(initialChannel, 'ack');
    initial.send(JSON.stringify(control('mediate.request', 'mediate-failed', {caseId: 'case-1'})));
    await nextJson(initialChannel, 'ack');
    assert.equal((await nextJson(initialChannel, 'error')).code, 'mediation_failed');
    await first.gateway.waitForIdle();
    assert.equal(mediationCalls, 2);
    const failedState = await waitForPersistedState(tempDir,
      (state) => state.devices?.[0]?.pendingMediation?.terminalFailure === true);
    assert.equal(failedState.devices[0].pendingMediation.messageId, 'mediate-failed');
    await closeClient(initial);
    await first.gateway.shutdown();

    second = await listenGateway(tempDir, {
      mediatorService,
      ttsService: {async synthesize() { return Buffer.from([1, 0]); }}
    });
    const replay = await openClient(second.url);
    const replayChannel = inbox(replay);
    await authenticate(replay, replayChannel, 'hello-2');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mediationCalls, 2);

    replay.send(JSON.stringify(control('mediate.request', 'mediate-new', {caseId: 'case-1'})));
    await nextJson(replayChannel, 'ack');
    await nextJson(replayChannel, 'audio.end');
    await second.gateway.waitForIdle();
    assert.equal(mediationCalls, 3);
    await closeClient(replay);
  } finally {
    await first?.gateway.shutdown().catch(() => {});
    await second?.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('a terminal mediation failure is durable and re-notified after restart without another provider call', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-mediation-notification-'));
  const terminalCommitStarted = deferred();
  const releaseTerminalCommit = deferred();
  const backingStore = new AtomicJsonStateStore({stateDir: path.join(tempDir, 'state')});
  let terminalCommitHeld = false;
  const stateStore = {
    async cleanupParts() { return backingStore.cleanupParts(); },
    async load() { return backingStore.load(); },
    async commit(candidate) {
      await backingStore.commit(candidate);
      if (!terminalCommitHeld && candidate.devices.some(({pendingMediation}) =>
        pendingMediation?.terminalFailure === true)) {
        terminalCommitHeld = true;
        terminalCommitStarted.resolve();
        await releaseTerminalCommit.promise;
      }
    }
  };
  let mediationCalls = 0;
  const mediatorService = {async mediate() {
    mediationCalls += 1;
    throw new Error('terminal provider failure');
  }};
  let first;
  let second;
  try {
    first = await listenGateway(tempDir, {
      mediatorService,
      gatewayOptions: {caseManager: mediationReadyCases(), stateStore}
    });
    const initial = await openClient(first.url);
    const initialChannel = inbox(initial);
    await authenticate(initial, initialChannel);
    initial.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(initialChannel, 'ack');
    initial.send(JSON.stringify(control('mediate.request', 'mediate-terminal', {caseId: 'case-1'})));
    await nextJson(initialChannel, 'ack');
    await within(terminalCommitStarted.promise, 1_000, 'terminal mediation commit');

    const closed = new Promise((resolve) => initial.once('close', resolve));
    initial.terminate();
    await within(closed, 500, 'terminal mediation socket close');
    releaseTerminalCommit.resolve();
    assert.equal(await first.gateway.waitForIdle({timeoutMs: 1_000}), true);
    assert.equal(mediationCalls, 2);
    await first.gateway.shutdown();

    const statePath = path.join(tempDir, 'state', 'bridge-state.json');
    const terminalState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(terminalState.devices[0].pendingMediation.notificationPending, true);

    // Simulate the additive v1 shape written before notificationPending existed.
    delete terminalState.devices[0].pendingMediation.notificationPending;
    await writeFile(statePath, `${JSON.stringify(terminalState)}\n`, 'utf8');

    second = await listenGateway(tempDir, {mediatorService});
    const replay = await openClient(second.url);
    const replayChannel = inbox(replay);
    await authenticate(replay, replayChannel, 'hello-2');
    const recoveredFailure = await nextJson(replayChannel, 'error');
    assert.equal(recoveredFailure.code, 'mediation_failed');
    assert.equal(recoveredFailure.caseId, 'case-1');
    assert.equal(mediationCalls, 2);

    replay.send(JSON.stringify(control('mediate.request', 'mediate-terminal', {caseId: 'case-1'})));
    assert.equal((await nextJson(replayChannel, 'ack')).messageId, 'mediate-terminal');
    assert.equal((await nextJson(replayChannel, 'error')).code, 'mediation_failed');
    assert.equal(mediationCalls, 2);
    await closeClient(replay);
  } finally {
    releaseTerminalCommit.resolve();
    await second?.gateway.shutdown().catch(() => {});
    await first?.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('keeps an unconfirmed playback durable across a black-hole socket and clears it only after audio.played', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-playback-confirmation-'));
  const mediatorStarted = deferred();
  const releaseMediator = deferred();
  const voice = Buffer.from([9, 0, 8, 0]);
  const request = control('mediate.request', 'mediate-1', {caseId: 'case-1'});
  const first = await listenGateway(tempDir, {
    mediatorService: {async mediate() {
      mediatorStarted.resolve();
      await releaseMediator.promise;
      return validMediation();
    }},
    ttsService: {async synthesize() { return voice; }},
    gatewayOptions: {caseManager: mediationReadyCases()}
  });
  let second;
  let third;
  try {
    const blackHole = await openClient(first.url);
    const blackHoleChannel = inbox(blackHole);
    await authenticate(blackHole, blackHoleChannel);
    blackHole.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(blackHoleChannel, 'ack');
    blackHole.send(JSON.stringify(request));
    assert.equal((await nextJson(blackHoleChannel, 'ack')).messageId, 'mediate-1');
    await mediatorStarted.promise;
    blackHole._socket.pause();
    releaseMediator.resolve();
    assert.equal(await first.gateway.waitForIdle({timeoutMs: 1_000}), true);
    const afterBufferedSend = JSON.parse(await readFile(
      path.join(tempDir, 'state', 'bridge-state.json'), 'utf8'));
    assert.deepEqual(afterBufferedSend.devices[0].pendingMediation, {
      messageId: 'mediate-1', caseId: 'case-1', deliveryReady: true
    });
    const blackHoleClosed = new Promise((resolve) => blackHole.once('close', resolve));
    blackHole.terminate();
    await within(blackHoleClosed, 500, 'black-hole playback socket termination');
    await first.gateway.shutdown();

    let replayMediationCalls = 0;
    second = await listenGateway(tempDir, {
      mediatorService: {async mediate() {
        replayMediationCalls += 1;
        return validMediation('重连后再次播放。');
      }},
      ttsService: {async synthesize() { return voice; }}
    });
    const replay = await openClient(second.url);
    const replayChannel = inbox(replay);
    await authenticate(replay, replayChannel, 'hello-2');
    const chunks = [];
    let audioStart;
    let audioEnd;
    for (;;) {
      const message = await replayChannel.next();
      if (message.isBinary) chunks.push(decodeBinaryFrame(message.value).payload);
      else if (message.value.type === 'audio.start') audioStart = message.value;
      else if (message.value.type === 'audio.end') {
        audioEnd = message.value;
        break;
      } else if (message.value.type === 'error') {
        assert.fail(message.value.code);
      }
    }
    assert.equal(replayMediationCalls, 1);
    assert.equal(audioStart.mediationMessageId, 'mediate-1');
    assert.equal(audioEnd.mediationMessageId, 'mediate-1');
    assert.deepEqual(Buffer.concat(chunks), voice);
    assert.equal((await nextJson(replayChannel, 'state')).state, 'waiting');

    const played = control('audio.played', 'played-1', {
      caseId: 'case-1', mediationMessageId: 'mediate-1'
    });
    replay.send(JSON.stringify(played));
    const playedAck = await nextJson(replayChannel, 'ack');
    assert.deepEqual(playedAck, {
      v: 1, type: 'ack', messageId: 'played-1', caseId: 'case-1', accepted: true
    });
    await closeClient(replay);
    await second.gateway.shutdown();
    second = undefined;
    const confirmedState = JSON.parse(await readFile(
      path.join(tempDir, 'state', 'bridge-state.json'), 'utf8'));
    assert.equal(confirmedState.devices[0].pendingMediation, null);

    let unexpectedMediationCalls = 0;
    third = await listenGateway(tempDir, {
      mediatorService: {async mediate() {
        unexpectedMediationCalls += 1;
        return validMediation('不应再次播放。');
      }},
      ttsService: {async synthesize() { return voice; }}
    });
    const confirmed = await openClient(third.url);
    const confirmedChannel = inbox(confirmed);
    await authenticate(confirmed, confirmedChannel, 'hello-3');
    confirmed.send(JSON.stringify(request));
    assert.equal((await nextJson(confirmedChannel, 'ack')).messageId, 'mediate-1');
    await assert.rejects(() => confirmedChannel.next(100), /timed out/);
    confirmed.send(JSON.stringify(played));
    assert.deepEqual(await nextJson(confirmedChannel, 'ack'), playedAck);
    assert.equal(unexpectedMediationCalls, 0);
    await closeClient(confirmed);
  } finally {
    releaseMediator.resolve();
    await third?.gateway.shutdown().catch(() => {});
    await second?.gateway.shutdown().catch(() => {});
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('rejects premature, cross-device, and mismatched playback confirmations and commits before ACK', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-playback-boundary-'));
  const mediatorStarted = deferred();
  const releaseMediator = deferred();
  const confirmationCommitStarted = deferred();
  const releaseConfirmationCommit = deferred();
  let snapshot;
  let heldConfirmation = false;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) {
      snapshot = structuredClone(candidate);
      if (!heldConfirmation && candidate.devices.some((device) =>
        device.acks.some(({messageId}) => messageId === 'played-good') &&
        device.pendingMediation === null)) {
        heldConfirmation = true;
        confirmationCommitStarted.resolve();
        await releaseConfirmationCommit.promise;
      }
    }
  };
  const gateway = createDeviceGateway(gatewayOptions(tempDir, {
    mediatorService: {async mediate() {
      mediatorStarted.resolve();
      await releaseMediator.promise;
      return validMediation();
    }},
    ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
    gatewayOptions: {stateStore, caseManager: mediationReadyCases()}
  }));
  await gateway.listen({host: '127.0.0.1', port: 0});
  let owner;
  let attacker;
  try {
    const url = `ws://127.0.0.1:${gateway.address().port}/device`;
    owner = await openClient(url);
    const ownerChannel = inbox(owner);
    await authenticate(owner, ownerChannel);
    owner.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(ownerChannel, 'ack');
    owner.send(JSON.stringify(control('mediate.request', 'mediate-1', {caseId: 'case-1'})));
    await nextJson(ownerChannel, 'ack');
    await mediatorStarted.promise;

    owner.send(JSON.stringify(control('audio.played', 'played-too-soon', {
      caseId: 'case-1', mediationMessageId: 'mediate-1'
    })));
    assert.equal((await nextJson(ownerChannel, 'error')).code, 'playback_not_ready');

    attacker = await openClient(url);
    const attackerChannel = inbox(attacker);
    attacker.send(JSON.stringify(control('hello', 'hello-attacker', {
      deviceId: 'device-2', firmwareVersion: '1.0.0', token, capabilities: []
    })));
    await nextJson(attackerChannel, 'hello.ack');
    attacker.send(JSON.stringify(control('audio.played', 'played-attacker', {
      caseId: 'case-1', mediationMessageId: 'mediate-1'
    })));
    assert.equal((await nextJson(attackerChannel, 'error')).code, 'case_forbidden');
    await closeClient(attacker);
    attacker = undefined;

    releaseMediator.resolve();
    await nextJson(ownerChannel, 'audio.end');
    assert.equal((await nextJson(ownerChannel, 'state')).state, 'waiting');
    owner.send(JSON.stringify(control('audio.played', 'played-wrong-result', {
      caseId: 'case-1', mediationMessageId: 'different-mediation'
    })));
    assert.equal((await nextJson(ownerChannel, 'error')).code, 'playback_confirmation_conflict');
    assert.equal(snapshot.devices.find(({deviceId}) => deviceId === 'device-1')
      .pendingMediation.messageId, 'mediate-1');

    const confirmation = control('audio.played', 'played-good', {
      caseId: 'case-1', mediationMessageId: 'mediate-1'
    });
    owner.send(JSON.stringify(confirmation));
    await within(confirmationCommitStarted.promise, 500, 'playback confirmation commit');
    await assert.rejects(() => ownerChannel.next(40), /timed out/);
    assert.equal(snapshot.devices.find(({deviceId}) => deviceId === 'device-1').pendingMediation, null);
    releaseConfirmationCommit.resolve();
    const ack = await nextJson(ownerChannel, 'ack');
    assert.equal(ack.messageId, 'played-good');
    owner.send(JSON.stringify(confirmation));
    assert.deepEqual(await nextJson(ownerChannel, 'ack'), ack);
  } finally {
    releaseMediator.resolve();
    releaseConfirmationCommit.resolve();
    if (attacker) await closeClient(attacker).catch(() => {});
    if (owner) await closeClient(owner).catch(() => {});
    await gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('a missing referenced WAV invalidates its durable segment ACK and permits an exact from-zero replay', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-missing-'));
  const asrStarted = deferred();
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe(_wavPath, {signal}) {
      asrStarted.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }}
  });
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    const replay = await recordOne(ws, channel, {caseId: 'case-1', segmentId: 'a-1', speaker: 'A'});
    await asrStarted.promise;
    await first.gateway.shutdown({graceMs: 0, cancelGraceMs: 100});
    const wavName = (await readdir(tempDir)).find((name) => SEGMENT_WAV_NAME.test(name));
    assert.ok(wavName);
    await rm(path.join(tempDir, wavName), {force: true});

    const second = await listenGateway(tempDir, {
      asrService: {async transcribe() { return '重新录制成功'; }}
    });
    try {
      const client = await openClient(second.url);
      const secondChannel = inbox(client);
      await authenticate(client, secondChannel, 'hello-2');
      client.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
      await nextJson(secondChannel, 'ack');
      client.send(replay.start);
      const admission = await nextJson(secondChannel, 'ack');
      assert.equal(admission.messageId, 'start-a-1');
      assert.equal(admission.accepted, true);
      client.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
      client.send(replay.end);
      assert.equal((await nextJson(secondChannel, 'ack')).durable, true);
      await nextJson(secondChannel, 'transcript.saved');
      await closeClient(client);
    } finally {
      await second.gateway.shutdown();
    }
  } finally {
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('shutdown during a pre-durable WAV rename persists a replayable segment instead of an orphaned queued state', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-shutdown-rename-'));
  const renameStarted = deferred();
  const releaseRename = deferred();
  const fileSystem = {
    ...realFs,
    async rename(...args) {
      if (String(args[1]).endsWith('.wav')) {
        renameStarted.resolve();
        await releaseRename.promise;
      }
      return realFs.rename(...args);
    }
  };
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe() { assert.fail('pre-durable audio must not be transcribed'); }},
    gatewayOptions: {fileSystem}
  });
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    const start = startFrame({messageId: 'start-a-1', caseId: 'case-1', segmentId: 'a-1', speaker: 'A'});
    const end = endFrame({messageId: 'end-a-1', caseId: 'case-1', segmentId: 'a-1'});
    ws.send(start);
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    ws.send(end);
    await renameStarted.promise;

    await first.gateway.shutdown({graceMs: 10, cancelGraceMs: 10, closeGraceMs: 10});
    releaseRename.resolve();
    assert.equal(await first.gateway.waitForIdle({timeoutMs: 500}), true);

    const second = await listenGateway(tempDir, {
      asrService: {async transcribe() { return '关机后重新录制成功'; }}
    });
    try {
      const replay = await openClient(second.url);
      const replayChannel = inbox(replay);
      await authenticate(replay, replayChannel, 'hello-2');
      replay.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
      await nextJson(replayChannel, 'ack');
      replay.send(start);
      assert.equal((await nextJson(replayChannel, 'ack')).accepted, true);
      replay.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
      replay.send(end);
      assert.equal((await nextJson(replayChannel, 'ack')).durable, true);
      await nextJson(replayChannel, 'transcript.saved');
      await closeClient(replay);
    } finally {
      await second.gateway.shutdown();
    }
  } finally {
    releaseRename.resolve();
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('startup deletes only strict regular orphan artifacts and preserves referenced WAVs, unrelated files, and symlinks', async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-persist-cleanup-'));
  const firstAsrStarted = deferred();
  const first = await listenGateway(tempDir, {
    asrService: {async transcribe(_wavPath, {signal}) {
      firstAsrStarted.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    }}
  });
  let second;
  try {
    const ws = await openClient(first.url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'case-start', {caseId: 'case-1'})));
    await nextJson(channel, 'ack');
    await recordOne(ws, channel, {caseId: 'case-1', segmentId: 'a-1', speaker: 'A'});
    await firstAsrStarted.promise;
    await first.gateway.shutdown({graceMs: 0, cancelGraceMs: 100});

    const referenced = (await readdir(tempDir)).filter((name) => /^segment-[0-9a-f-]+\.wav$/i.test(name));
    assert.equal(referenced.length, 1);
    const orphanWav = `segment-${randomUUID()}.wav`;
    const stalePart = `segment-${randomUUID()}.part`;
    const unrelated = 'customer-audio.wav';
    await Promise.all([
      writeFile(path.join(tempDir, orphanWav), 'orphan'),
      writeFile(path.join(tempDir, stalePart), 'partial'),
      writeFile(path.join(tempDir, unrelated), 'keep')
    ]);
    const target = path.join(tempDir, 'target.txt');
    const linkName = `segment-${randomUUID()}.wav`;
    let linked = false;
    await writeFile(target, 'target');
    try {
      await symlink(target, path.join(tempDir, linkName), 'file');
      linked = true;
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
      t.diagnostic('symlink creation is unavailable for this Windows account');
    }

    second = await listenGateway(tempDir, {
      asrService: {async transcribe(_wavPath, {signal}) {
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
      }}
    });
    const names = await readdir(tempDir);
    assert.equal(names.includes(referenced[0]), true);
    assert.equal(names.includes(orphanWav), false);
    assert.equal(names.includes(stalePart), false);
    assert.equal(names.includes(unrelated), true);
    assert.equal(await readFile(target, 'utf8'), 'target');
    if (linked) assert.equal(names.includes(linkName), true);
  } finally {
    await second?.gateway.shutdown({graceMs: 0, cancelGraceMs: 100}).catch(() => {});
    await first.gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});
