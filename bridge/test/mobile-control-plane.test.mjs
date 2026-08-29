import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {CaseManager} from '../src/case-manager.mjs';
import {createDeviceGateway} from '../src/device-gateway.mjs';

const token = 'mobile-control-device-token';
const audio = {sampleRate: 16000, bits: 16, channels: 1};

function readyCases({includeB = true} = {}) {
  const cases = new CaseManager();
  cases.startCase('device-mobile-1', 'case-mobile-1');
  for (const [speaker, segmentId, transcript] of [
    ['A', 'segment-mobile-a', 'A 的累计陈述'],
    ...(includeB ? [['B', 'segment-mobile-b', 'B 的累计陈述']] : [])
  ]) {
    cases.startSegment({caseId: 'case-mobile-1', segmentId, speaker, audio});
    cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
    cases.endSegment(segmentId);
    cases.saveTranscript(segmentId, transcript);
  }
  return cases;
}

async function openAuthenticated(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/device`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const ack = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello timeout')), 2_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString('utf8')));
    });
  });
  socket.send(JSON.stringify({
    v: 1,
    type: 'hello',
    messageId: 'hello-mobile-1',
    deviceId: 'device-mobile-1',
    firmwareVersion: '2.1.0',
    token,
    capabilities: ['recording', 'voice']
  }));
  assert.equal((await ack).type, 'hello.ack');
  return socket;
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close();
  });
}

async function withGateway({caseManager = readyCases(), mediatorService} = {}, run) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-mobile-control-'));
  const gateway = createDeviceGateway({
    deviceToken: token,
    tempDir,
    stateDir: path.join(tempDir, 'state'),
    caseManager,
    asrService: {async transcribe() { throw new Error('unused'); }},
    mediatorService: mediatorService ?? {async mediate() {
      return {
        conflictSummary: '总结', aPosition: 'A', bPosition: 'B',
        aCanImprove: 'A改进', bCanImprove: 'B改进', commonGround: '共识',
        suggestions: ['建议'], spokenText: '请双方先冷静沟通。'
      };
    }},
    ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
    createMediatorSession: async () => 'mobile-session',
    logger: {info() {}, warn() {}, error() {}}
  });
  await gateway.listen({host: '127.0.0.1', port: 0});
  try {
    await run(gateway, gateway.address().port);
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
}

test('mobileSnapshot exposes a sanitized online case with cumulative A/B transcripts', async () => {
  await withGateway({}, async (gateway, port) => {
    const socket = await openAuthenticated(port);
    const snapshot = gateway.mobileSnapshot();
    assert.equal(snapshot.devices.length, 1);
    const device = snapshot.devices[0];
    assert.equal(device.deviceId, 'device-mobile-1');
    assert.equal(device.online, true);
    assert.equal(device.firmwareVersion, '2.1.0');
    assert.equal(device.state, 'waiting');
    assert.equal(device.currentCaseId, 'case-mobile-1');
    assert.equal(typeof device.lastSeenAt, 'number');
    assert.deepEqual(device.case, {
      caseId: 'case-mobile-1',
      canMediate: true,
      speakers: {
        A: [{segmentId: 'segment-mobile-a', speaker: 'A', state: 'saved', transcript: 'A 的累计陈述', failure: null}],
        B: [{segmentId: 'segment-mobile-b', speaker: 'B', state: 'saved', transcript: 'B 的累计陈述', failure: null}]
      }
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /mobile-control-device-token|pcm|audio/i);
    await closeSocket(socket);
    assert.equal(gateway.mobileSnapshot().devices[0].online, false);
  });
});

test('requestMobileMediation durably admits a ready online device and starts one mediation', async () => {
  let calls = 0;
  await withGateway({mediatorService: {async mediate() {
    calls += 1;
    return {
      conflictSummary: '总结', aPosition: 'A', bPosition: 'B',
      aCanImprove: 'A改进', bCanImprove: 'B改进', commonGround: '共识',
      suggestions: ['建议'], spokenText: '请双方先冷静沟通。'
    };
  }}}, async (gateway, port) => {
    const socket = await openAuthenticated(port);
    const accepted = await gateway.requestMobileMediation('device-mobile-1');
    assert.equal(accepted.caseId, 'case-mobile-1');
    assert.match(accepted.requestId, /^mobile-mediate-/);
    await gateway.waitForIdle({timeoutMs: 2_000});
    assert.equal(calls, 1);
    await closeSocket(socket);
  });
});

test('concurrent mobile mediation submissions reuse one pending durable request', async () => {
  let calls = 0;
  await withGateway({mediatorService: {async mediate() {
    calls += 1;
    return {
      conflictSummary: '总结', aPosition: 'A', bPosition: 'B',
      aCanImprove: 'A改进', bCanImprove: 'B改进', commonGround: '共识',
      suggestions: ['建议'], spokenText: '请双方先冷静沟通。'
    };
  }}}, async (gateway, port) => {
    const socket = await openAuthenticated(port);
    const [first, second] = await Promise.all([
      gateway.requestMobileMediation('device-mobile-1'),
      gateway.requestMobileMediation('device-mobile-1')
    ]);
    assert.deepEqual(second, first);
    await gateway.waitForIdle({timeoutMs: 2_000});
    assert.equal(calls, 1);
    await closeSocket(socket);
  });
});

test('requestMobileMediation reports stable not-found, offline and not-ready codes', async () => {
  await withGateway({}, async (gateway, port) => {
    await assert.rejects(
      () => gateway.requestMobileMediation('unknown-device'),
      (error) => error?.code === 'device_not_found'
    );
    const socket = await openAuthenticated(port);
    await closeSocket(socket);
    await assert.rejects(
      () => gateway.requestMobileMediation('device-mobile-1'),
      (error) => error?.code === 'device_offline'
    );
  });

  await withGateway({caseManager: readyCases({includeB: false})}, async (gateway, port) => {
    const socket = await openAuthenticated(port);
    await assert.rejects(
      () => gateway.requestMobileMediation('device-mobile-1'),
      (error) => error?.code === 'mediation_not_ready'
    );
    await closeSocket(socket);
  });
});
