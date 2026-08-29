import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {get} from 'node:http';
import * as realFs from 'node:fs/promises';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function settleWithin(promise, milliseconds = 1_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('operation did not settle within its bound')), milliseconds);
      timer.unref?.();
    })
  ]);
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

function serializedCaseFromPrompt(prompt) {
  return prompt.split('\n').find((line) => line.startsWith('{'));
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

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = get({host: '127.0.0.1', port, path: pathname}, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
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

async function segmentArtifacts(tempDir) {
  return (await readdir(tempDir)).filter((name) => /^segment-/i.test(name));
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

test('a newer authenticated generation closes the stale device socket', async () => {
  await withGateway(async ({url}) => {
    const first = await openClient(url);
    const firstChannel = inbox(first);
    await authenticate(first, firstChannel);
    first.send(JSON.stringify(control(
      'case.start', 'generation-owner-case-start',
      {caseId: 'generation-owner-case'})));
    await nextJson(firstChannel, 'ack');
    first.send(startFrame({
      messageId: 'stale-owner-start', caseId: 'generation-owner-case',
      segmentId: 'stale-owner-a', speaker: 'A'
    }));
    await nextJson(firstChannel, 'ack');
    first.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0])));
    const firstClosed = new Promise((resolve) => {
      first.once('close', (code) => resolve(code));
    });

    const second = await openClient(url);
    const secondChannel = inbox(second);
    await authenticate(second, secondChannel);
    assert.equal(await settleWithin(firstClosed), 4004);

    second.send(JSON.stringify(control(
      'case.start', 'generation-owner-case-start',
      {caseId: 'generation-owner-case'})));
    assert.equal((await nextJson(secondChannel, 'ack')).accepted, true);
    second.send(startFrame({
      messageId: 'replacement-owner-start', caseId: 'generation-owner-case',
      segmentId: 'replacement-owner-b', speaker: 'B'
    }));
    const replacement = await nextJson(secondChannel);
    assert.equal(replacement.type, 'ack');
    assert.equal(replacement.messageId, 'replacement-owner-start');
    await closeClient(second);
  });
});

test('requires hello before accepting a binary CONTROL frame', async () => {
  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    ws.send(encodeBinaryFrame({
      kind: FrameKind.CONTROL,
      streamType: 0,
      flags: 0,
      sequence: 0,
      payload: Buffer.from([0x01])
    }));

    const closed = await new Promise((resolve) => {
      ws.once('close', (code, reason) => resolve({code, reason: reason.toString()}));
    });
    assert.deepEqual(closed, {code: 4001, reason: 'hello required'});
  });
});

test('silently accepts authenticated CONTROL without mutating state and keeps the socket usable', async () => {
  let caseStarts = 0;
  let segmentStarts = 0;
  let chunks = 0;
  let segmentEnds = 0;
  class CountingCases extends CaseManager {
    startCase(...args) {
      caseStarts += 1;
      return super.startCase(...args);
    }
    startSegment(...args) {
      segmentStarts += 1;
      return super.startSegment(...args);
    }
    appendChunk(...args) {
      chunks += 1;
      return super.appendChunk(...args);
    }
    endSegment(...args) {
      segmentEnds += 1;
      return super.endSegment(...args);
    }
  }
  const cases = new CountingCases();

  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(encodeBinaryFrame({
      kind: FrameKind.CONTROL,
      streamType: 0,
      flags: 0,
      sequence: 0,
      payload: Buffer.from([0xde, 0xad, 0xbe, 0xef])
    }));

    await assert.rejects(() => channel.next(100), /timed out waiting for gateway message/);
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(cases.cases.size, 0);
    assert.equal(cases.segments.size, 0);
    assert.deepEqual({caseStarts, segmentStarts, chunks, segmentEnds}, {
      caseStarts: 0,
      segmentStarts: 0,
      chunks: 0,
      segmentEnds: 0
    });

    ws.send(JSON.stringify(control('case.start', 'post-control-case-start', {caseId: 'post-control-case'})));
    assert.deepEqual(await nextJson(channel, 'ack'), {
      v: 1,
      type: 'ack',
      messageId: 'post-control-case-start',
      caseId: 'post-control-case',
      accepted: true
    });
    assert.equal(caseStarts, 1);
    await closeClient(ws);
  }, {caseManager: cases});
});

test('still reports invalid_frame for malformed authenticated binary input', async () => {
  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(Buffer.from([0x58, 0x4c, 0x01]));

    const error = await nextJson(channel, 'error');
    assert.equal(error.code, 'invalid_frame');
    assert.equal(ws.readyState, WebSocket.OPEN);
    await closeClient(ws);
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

test('returns the original hello.ack only for an exact authenticated hello retry', async () => {
  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    const hello = control('hello', 'hello-retry-1', {
      deviceId: 'device-1',
      firmwareVersion: '1.0.0',
      token,
      capabilities: ['recording', 'voice']
    });
    ws.send(JSON.stringify(hello));
    const first = await nextJson(channel, 'hello.ack');
    ws.send(JSON.stringify(hello));
    assert.deepEqual(await nextJson(channel), first);

    ws.send(JSON.stringify({...hello, firmwareVersion: '2.0.0'}));
    const conflict = await nextJson(channel);
    assert.equal(conflict.type, 'error');
    assert.equal(conflict.code, 'message_id_conflict');
    await closeClient(ws);
  });
});

test('rejects cross-device speech and mediation before segment, file, ASR, or mediator effects', async () => {
  let mediatorCalls = 0;
  await withGateway(async ({url, tempDir, cases, transcripts}) => {
    const owner = await openClient(url);
    const ownerChannel = inbox(owner);
    await authenticate(owner, ownerChannel, token, 'device-owner');
    owner.send(JSON.stringify(control('case.start', 'owner-case-start', {caseId: 'owner-case'})));
    await nextJson(ownerChannel, 'ack');

    const attacker = await openClient(url);
    const attackerChannel = inbox(attacker);
    await authenticate(attacker, attackerChannel, token, 'device-attacker');
    attacker.send(startFrame({messageId: 'attacker-start', caseId: 'owner-case', segmentId: 'attack-a', speaker: 'A'}));
    const rejectedStart = await nextJson(attackerChannel);
    assert.equal(rejectedStart.type, 'error');
    assert.equal(rejectedStart.code, 'case_forbidden');
    attacker.send(endFrame({messageId: 'attacker-end', caseId: 'owner-case', segmentId: 'attack-a', bytes: 2, lastSequence: 0}));
    assert.equal((await nextJson(attackerChannel, 'error')).code, 'case_forbidden');
    attacker.send(JSON.stringify(control('mediate.request', 'attacker-mediate', {caseId: 'owner-case'})));
    assert.equal((await nextJson(attackerChannel, 'error')).code, 'case_forbidden');

    assert.deepEqual(cases.snapshot('owner-case').speakers, {A: [], B: []});
    assert.deepEqual(await segmentArtifacts(tempDir), []);
    assert.deepEqual(transcripts, []);
    assert.equal(mediatorCalls, 0);
    await closeClient(attacker);
    await closeClient(owner);
  }, {
    mediatorService: {async mediate() { mediatorCalls += 1; throw new Error('must not mediate another device case'); }}
  });
});

test('releases CaseManager raw audio as soon as the durable WAV is staged', async () => {
  const asrStarted = deferred();
  const asrService = {
    async transcribe(_wavPath, {signal} = {}) {
      asrStarted.resolve();
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    }
  };
  await withGateway(async ({url, cases}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'release-case-start', {caseId: 'release-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'release-start', caseId: 'release-case', segmentId: 'release-a', speaker: 'A'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    ws.send(endFrame({messageId: 'release-end', caseId: 'release-case', segmentId: 'release-a', bytes: 4, lastSequence: 0}));
    await nextJson(channel, 'ack');
    await settleWithin(asrStarted.promise);

    assert.throws(() => cases.endSegment('release-a'), /released|no assembled PCM/);
    await closeClient(ws);
  }, {asrService});
});

test('starting a new case aborts old work, forgets case sessions, and removes its durable WAV', async () => {
  const asrStarted = deferred();
  const oldCaseAborted = deferred();
  const forgotten = [];
  let asrCalls = 0;
  const asrService = {
    async transcribe(_wavPath, {signal} = {}) {
      asrCalls += 1;
      asrStarted.resolve();
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          oldCaseAborted.resolve();
          reject(signal.reason);
        }, {once: true});
      });
    },
    forgetCase(caseId) { forgotten.push(caseId); }
  };
  await withGateway(async ({gateway, url, tempDir, cases}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'old-case-start', {caseId: 'old-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'old-start', caseId: 'old-case', segmentId: 'old-a', speaker: 'A'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    ws.send(endFrame({messageId: 'old-end', caseId: 'old-case', segmentId: 'old-a', bytes: 4, lastSequence: 0}));
    await nextJson(channel, 'ack');
    await settleWithin(asrStarted.promise);
    ws.send(startFrame({messageId: 'old-queued-start', caseId: 'old-case', segmentId: 'old-b', speaker: 'B'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([3, 0, 4, 0])));
    ws.send(endFrame({messageId: 'old-queued-end', caseId: 'old-case', segmentId: 'old-b', bytes: 4, lastSequence: 0}));
    await nextJson(channel, 'ack');

    ws.send(JSON.stringify(control('case.start', 'new-case-start', {caseId: 'new-case'})));
    await nextJson(channel, 'ack');

    await settleWithin(oldCaseAborted.promise);
    assert.equal(await gateway.waitForIdle({timeoutMs: 500}), true);
    assert.equal(asrCalls, 1);
    assert.deepEqual(forgotten, ['old-case']);
    assert.throws(() => cases.snapshot('old-case'), /unknown case/);
    assert.deepEqual(await segmentArtifacts(tempDir), []);
    ws.send(JSON.stringify(control('mediate.request', 'late-old-mediate', {caseId: 'old-case'})));
    assert.equal((await nextJson(channel, 'error')).code, 'case_not_found');
    await closeClient(ws);
  }, {asrService});
});

test('evicting a case forgets its mediator session before the case id is reused', async () => {
  const mediation = {
    conflictSummary: '双方对安排有分歧。',
    aPosition: 'A 希望提前计划。',
    bPosition: 'B 希望保留弹性。',
    aCanImprove: 'A 可以说明优先级。',
    bCanImprove: 'B 可以主动确认时间。',
    commonGround: '双方都希望顺利完成。',
    suggestions: ['共同列出时间表。'],
    spokenText: '请共同列出时间表。'
  };
  const created = [];
  const used = [];
  await withGateway(async ({gateway, url, cases}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);

    const startAndPopulate = async (messageId, suffix) => {
      ws.send(JSON.stringify(control('case.start', messageId, {caseId: 'reused-case'})));
      await nextJson(channel, 'ack');
      for (const [speaker, text] of [['A', 'A 陈述'], ['B', 'B 陈述']]) {
        const segmentId = `${speaker.toLowerCase()}-${suffix}`;
        cases.startSegment({caseId: 'reused-case', segmentId, speaker, audio});
        cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
        cases.endSegment(segmentId);
        cases.saveTranscript(segmentId, text);
      }
    };
    const mediate = async (messageId) => {
      ws.send(JSON.stringify(control('mediate.request', messageId, {caseId: 'reused-case'})));
      await nextJson(channel, 'ack');
      await nextJson(channel, 'audio.end');
      await gateway.waitForIdle();
    };

    await startAndPopulate('first-reused-start', 'first');
    await mediate('first-reused-mediate');
    ws.send(JSON.stringify(control('case.start', 'intervening-start', {caseId: 'intervening-case'})));
    await nextJson(channel, 'ack');
    await startAndPopulate('second-reused-start', 'second');
    await mediate('second-reused-mediate');

    assert.deepEqual(created, ['reused-case', 'reused-case']);
    assert.deepEqual(used, ['mediator-session-1', 'mediator-session-2']);
    await closeClient(ws);
  }, {
    createMediatorSession: async (caseId) => {
      created.push(caseId);
      return `mediator-session-${created.length}`;
    },
    mediatorService: {async mediate(_snapshot, sessionId) { used.push(sessionId); return mediation; }},
    ttsService: {async synthesize() { return Buffer.from([1, 0]); }}
  });
});

test('reports the stable audio size limit code before accepting overflow', async () => {
  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'limit-case-start', {caseId: 'limit-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'limit-start', caseId: 'limit-case', segmentId: 'limit-a', speaker: 'A'}));
    await nextJson(channel, 'ack');
    for (let sequence = 0; sequence < 300; sequence += 1) {
      ws.send(streamFrame(FrameKind.STREAM_CHUNK, sequence, Buffer.alloc(64_000)));
    }
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 300, Buffer.alloc(2)));

    const error = await nextJson(channel, 'error');
    assert.equal(error.code, 'audio_size_limit_exceeded');
    assert.equal(error.message, 'Recording audio exceeded its allowed duration');
    await closeClient(ws);
  });
});

test('reports the stable case segment limit code for the sixty-fifth segment', async () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'full-case');
  for (let index = 0; index < 64; index += 1) {
    cases.startSegment({caseId: 'full-case', segmentId: `existing-${index}`, speaker: index % 2 ? 'B' : 'A', audio});
  }
  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'full-case-start', {caseId: 'full-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'overflow-segment-start', caseId: 'full-case', segmentId: 'sixty-fifth', speaker: 'A'}));

    const error = await nextJson(channel, 'error');
    assert.equal(error.code, 'case_segment_limit_exceeded');
    assert.equal(error.message, 'This case already has the maximum number of recordings');
    await closeClient(ws);
  }, {caseManager: cases});
});

test('shutdown waits for in-flight STREAM_END routing and blocks its post-stop WAV and ASR continuation', async () => {
  const renameStarted = deferred();
  const releaseRename = deferred();
  let asrCalls = 0;
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
  await withGateway(async ({gateway, url, tempDir}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'shutdown-case-start', {caseId: 'shutdown-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'shutdown-speech-start', caseId: 'shutdown-case', segmentId: 'shutdown-a', speaker: 'A'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    ws.send(endFrame({messageId: 'shutdown-speech-end', caseId: 'shutdown-case', segmentId: 'shutdown-a', bytes: 4, lastSequence: 0}));

    await settleWithin(renameStarted.promise);
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    let shutdownSettled = false;
    const shutdown = gateway.shutdown({graceMs: 50, cancelGraceMs: 25}).then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownSettled, false);
    await settleWithin(shutdown);
    assert.equal(await closed, 1001);
    assert.deepEqual(await segmentArtifacts(tempDir), []);
    releaseRename.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(asrCalls, 0);
    assert.deepEqual(await segmentArtifacts(tempDir), []);
  }, {
    asrService: {async transcribe() { asrCalls += 1; return 'must not transcribe'; }},
    gatewayOptions: {fileSystem}
  });
});

test('shutdown aborts never-resolving ASR, closes clients, and preserves its durable WAV for restart', async () => {
  const asrStarted = deferred();
  let aborts = 0;
  const asrService = {
    async transcribe(_wavPath, {signal} = {}) {
      signal?.addEventListener('abort', () => { aborts += 1; }, {once: true});
      asrStarted.resolve();
      return new Promise(() => {});
    }
  };
  await withGateway(async ({gateway, url, tempDir}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'asr-shutdown-case-start', {caseId: 'asr-shutdown-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'asr-shutdown-start', caseId: 'asr-shutdown-case', segmentId: 'asr-never', speaker: 'A'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    ws.send(endFrame({messageId: 'asr-shutdown-end', caseId: 'asr-shutdown-case', segmentId: 'asr-never', bytes: 4, lastSequence: 0}));
    await nextJson(channel, 'ack');
    await settleWithin(asrStarted.promise);

    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    const startedAt = Date.now();
    await settleWithin(gateway.shutdown({graceMs: 25, cancelGraceMs: 25}), 750);
    assert.ok(Date.now() - startedAt < 750);
    assert.equal(aborts, 1);
    assert.equal(await closed, 1001);
    assert.equal((await segmentArtifacts(tempDir)).filter((name) => name.endsWith('.wav')).length, 1);
  }, {asrService});
});

test('default cancellation grace covers child termination and preserves restartable ASR input within five seconds', async () => {
  const asrStarted = deferred();
  let childSettled = false;
  let wavRemoveAttempts = 0;
  const fileSystem = {
    ...realFs,
    async rm(candidate, options) {
      if (String(candidate).endsWith('.wav') && ++wavRemoveAttempts <= 2) {
        throw Object.assign(new Error('temporarily locked'), {code: 'EBUSY'});
      }
      return realFs.rm(candidate, options);
    }
  };
  const asrService = {
    async transcribe(_wavPath, {signal} = {}) {
      asrStarted.resolve();
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const timer = setTimeout(() => {
            childSettled = true;
            reject(signal.reason);
          }, 2_100);
          timer.unref?.();
        }, {once: true});
      });
    }
  };
  await withGateway(async ({gateway, url, tempDir}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'grace-case-start', {caseId: 'grace-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'grace-start', caseId: 'grace-case', segmentId: 'grace-a', speaker: 'A'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
    ws.send(endFrame({messageId: 'grace-end', caseId: 'grace-case', segmentId: 'grace-a', bytes: 4, lastSequence: 0}));
    await nextJson(channel, 'ack');
    await settleWithin(asrStarted.promise);

    const startedAt = Date.now();
    await gateway.shutdown();
    const elapsed = Date.now() - startedAt;
    assert.equal(childSettled, true);
    assert.ok(elapsed >= 2_500, `shutdown returned too early after ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `shutdown exceeded its five-second budget at ${elapsed}ms`);
    assert.equal(wavRemoveAttempts, 0);
    assert.equal((await segmentArtifacts(tempDir)).filter((name) => name.endsWith('.wav')).length, 1);
  }, {asrService, gatewayOptions: {fileSystem}});
});

test('shutdown aborts never-resolving TTS and completes without post-stop playback', async () => {
  const ttsStarted = deferred();
  let aborts = 0;
  const mediation = {
    conflictSummary: '双方对安排有分歧。',
    aPosition: 'A 希望提前计划。',
    bPosition: 'B 希望保留弹性。',
    aCanImprove: 'A 可以说明优先级。',
    bCanImprove: 'B 可以主动确认时间。',
    commonGround: '双方都希望顺利完成。',
    suggestions: ['共同列出时间表。'],
    spokenText: '请共同列出时间表。'
  };
  const ttsService = {
    async synthesize(_text, {signal} = {}) {
      signal?.addEventListener('abort', () => { aborts += 1; }, {once: true});
      ttsStarted.resolve();
      return new Promise(() => {});
    }
  };
  await withGateway(async ({gateway, url, tempDir}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'tts-shutdown-case-start', {caseId: 'tts-shutdown-case'})));
    await nextJson(channel, 'ack');
    for (const [segmentId, speaker] of [['a-tts', 'A'], ['b-tts', 'B']]) {
      ws.send(startFrame({messageId: `start-${segmentId}`, caseId: 'tts-shutdown-case', segmentId, speaker}));
      await nextJson(channel, 'ack');
      ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
      ws.send(endFrame({messageId: `end-${segmentId}`, caseId: 'tts-shutdown-case', segmentId, bytes: 4, lastSequence: 0}));
      await nextJson(channel, 'ack');
      await nextJson(channel, 'transcript.saved');
    }
    ws.send(JSON.stringify(control('mediate.request', 'tts-shutdown-mediate', {caseId: 'tts-shutdown-case'})));
    await nextJson(channel, 'ack');
    await settleWithin(ttsStarted.promise);

    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    await settleWithin(gateway.shutdown({graceMs: 25, cancelGraceMs: 25}), 750);
    assert.equal(aborts, 1);
    assert.equal(await closed, 1001);
    assert.deepEqual(await segmentArtifacts(tempDir), []);
  }, {
    mediatorService: {async mediate() { return mediation; }},
    ttsService
  });
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

test('an exact speech.start retry after reconnect restores retained progress without duplicating chunks', async () => {
  let transcriptions = 0;
  let receivedPcm;
  const asrService = {
    async transcribe(wavPath) {
      transcriptions += 1;
      receivedPcm = parsePcmWav(await readFile(wavPath)).pcm;
      return '断线续传完成';
    }
  };
  await withGateway(async ({gateway, url}) => {
    const first = await openClient(url);
    const firstChannel = inbox(first);
    await authenticate(first, firstChannel);
    first.send(JSON.stringify(control('case.start', 'resume-case-start', {caseId: 'resume-case'})));
    await nextJson(firstChannel, 'ack');
    const retryableStart = startFrame({messageId: 'resume-start', caseId: 'resume-case', segmentId: 'resume-a', speaker: 'A'});
    first.send(retryableStart);
    const originalStartAck = await nextJson(firstChannel, 'ack');
    const firstChunk = Buffer.from([1, 0, 2, 0]);
    first.send(streamFrame(FrameKind.STREAM_CHUNK, 0, firstChunk));
    await closeClient(first);

    const second = await openClient(url);
    const secondChannel = inbox(second);
    await authenticate(second, secondChannel);
    second.send(retryableStart);
    assert.deepEqual(await nextJson(secondChannel, 'ack'), originalStartAck);
    second.send(streamFrame(FrameKind.STREAM_CHUNK, 0, firstChunk));
    const secondChunk = Buffer.from([3, 0, 4, 0]);
    second.send(streamFrame(FrameKind.STREAM_CHUNK, 1, secondChunk));
    second.send(endFrame({messageId: 'resume-end', caseId: 'resume-case', segmentId: 'resume-a', bytes: 8, lastSequence: 1}));
    assert.equal((await nextJson(secondChannel, 'ack')).durable, true);
    await nextJson(secondChannel, 'transcript.saved');
    await gateway.waitForIdle();

    assert.equal(transcriptions, 1);
    assert.deepEqual(receivedPcm, Buffer.concat([firstChunk, secondChunk]));
    await closeClient(second);
  }, {asrService});
});

test('socket close during durable commit does not orphan or fail the committing segment', async () => {
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
  await withGateway(async ({gateway, url, cases}) => {
    const first = await openClient(url);
    const firstChannel = inbox(first);
    await authenticate(first, firstChannel);
    first.send(JSON.stringify(control('case.start', 'commit-close-case-start', {caseId: 'commit-close-case'})));
    await nextJson(firstChannel, 'ack');
    const start = startFrame({messageId: 'commit-close-start', caseId: 'commit-close-case', segmentId: 'commit-close-a', speaker: 'A'});
    const end = endFrame({messageId: 'commit-close-end', caseId: 'commit-close-case', segmentId: 'commit-close-a', bytes: 4, lastSequence: 0});
    const pcm = Buffer.from([1, 0, 2, 0]);
    first.send(start);
    await nextJson(firstChannel, 'ack');
    first.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm));
    first.send(end);
    await settleWithin(renameStarted.promise);
    await closeClient(first);

    const second = await openClient(url);
    const channel = inbox(second);
    await authenticate(second, channel);
    second.send(JSON.stringify(control('case.start', 'commit-close-case-start', {caseId: 'commit-close-case'})));
    await nextJson(channel, 'ack');
    second.send(start);
    let replayStartSettled = false;
    const replayStart = nextJson(channel, 'ack').then((message) => {
      replayStartSettled = true;
      return message;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(replayStartSettled, false);

    releaseRename.resolve();
    assert.equal((await replayStart).type, 'ack');
    await gateway.waitForIdle();
    assert.equal(cases.snapshot('commit-close-case').speakers.A[0].state, 'saved');
    second.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm));
    second.send(end);
    const durable = await nextJson(channel, 'ack');
    assert.equal(durable.messageId, 'commit-close-end');
    assert.equal(durable.durable, true);
    await closeClient(second);
  }, {gatewayOptions: {fileSystem}});
});

test('old generation commit completion cannot clear newer recording ownership', async (t) => {
  for (const failOldCommit of [false, true]) {
    await t.test(failOldCommit ? 'old commit failure' : 'old commit success', async () => {
      const renameStarted = deferred();
      const releaseRename = deferred();
      let firstRename = true;
      const fileSystem = {
        ...realFs,
        async rename(...args) {
          if (firstRename && String(args[1]).endsWith('.wav')) {
            firstRename = false;
            renameStarted.resolve();
            await releaseRename.promise;
            if (failOldCommit) {
              throw Object.assign(new Error('injected old commit failure'), {code: 'EIO'});
            }
          }
          return realFs.rename(...args);
        }
      };

      await withGateway(async ({gateway, url, cases}) => {
        const first = await openClient(url);
        const firstChannel = inbox(first);
        await authenticate(first, firstChannel);
        first.send(JSON.stringify(control('case.start', 'owner-race-case-start', {
          caseId: 'owner-race-case'
        })));
        await nextJson(firstChannel, 'ack');
        first.send(startFrame({
          messageId: 'owner-race-old-start', caseId: 'owner-race-case',
          segmentId: 'owner-race-old-a', speaker: 'A'
        }));
        await nextJson(firstChannel, 'ack');
        first.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0])));
        first.send(endFrame({
          messageId: 'owner-race-old-end', caseId: 'owner-race-case',
          segmentId: 'owner-race-old-a', bytes: 2, lastSequence: 0
        }));
        await settleWithin(renameStarted.promise);

        const second = await openClient(url);
        const secondChannel = inbox(second);
        await authenticate(second, secondChannel);
        second.send(JSON.stringify(control('case.start', 'owner-race-case-start', {
          caseId: 'owner-race-case'
        })));
        await nextJson(secondChannel, 'ack');
        second.send(startFrame({
          messageId: 'owner-race-new-start', caseId: 'owner-race-case',
          segmentId: 'owner-race-new-b', speaker: 'B'
        }));
        assert.equal((await nextJson(secondChannel, 'ack')).messageId, 'owner-race-new-start');

        releaseRename.resolve();
        await gateway.waitForIdle();

        second.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([2, 0])));
        second.send(endFrame({
          messageId: 'owner-race-new-end', caseId: 'owner-race-case',
          segmentId: 'owner-race-new-b', bytes: 2, lastSequence: 0
        }));
        const durable = await nextJson(secondChannel, 'ack');
        assert.equal(durable.messageId, 'owner-race-new-end');
        assert.equal(durable.durable, true);
        await nextJson(secondChannel, 'transcript.saved');
        await gateway.waitForIdle();
        assert.equal(cases.snapshot('owner-race-case').speakers.B[0].state, 'saved');
        await closeClient(second);
      }, {gatewayOptions: {fileSystem}});
    });
  }
});

test('a replay socket closed while waiting for commit cannot poison a third exact replay', async () => {
  const renameStarted = deferred();
  const releaseRename = deferred();
  let failRename = true;
  const fileSystem = {
    ...realFs,
    async rename(...args) {
      if (failRename && String(args[1]).endsWith('.wav')) {
        failRename = false;
        renameStarted.resolve();
        await releaseRename.promise;
        throw Object.assign(new Error('injected commit failure'), {code: 'EIO'});
      }
      return realFs.rename(...args);
    }
  };
  await withGateway(async ({gateway, url, cases}) => {
    const first = await openClient(url);
    const firstChannel = inbox(first);
    await authenticate(first, firstChannel);
    first.send(JSON.stringify(control('case.start', 'commit-three-case-start', {caseId: 'commit-three-case'})));
    await nextJson(firstChannel, 'ack');
    const start = startFrame({
      messageId: 'commit-three-start', caseId: 'commit-three-case',
      segmentId: 'commit-three-a', speaker: 'A'
    });
    const end = endFrame({
      messageId: 'commit-three-end', caseId: 'commit-three-case',
      segmentId: 'commit-three-a', bytes: 4, lastSequence: 0
    });
    const pcm = Buffer.from([1, 0, 2, 0]);
    first.send(start);
    await nextJson(firstChannel, 'ack');
    first.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm));
    first.send(end);
    await settleWithin(renameStarted.promise);
    await closeClient(first);

    const second = await openClient(url);
    const secondChannel = inbox(second);
    await authenticate(second, secondChannel);
    second.send(JSON.stringify(control('case.start', 'commit-three-case-start', {caseId: 'commit-three-case'})));
    await nextJson(secondChannel, 'ack');
    second.send(start);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await closeClient(second);

    // Let the commit fail while the only waiter is already closed. Without a
    // post-await connection check that stale waiter reopens failed progress
    // and becomes active owner, so the third exact replay is rejected.
    releaseRename.resolve();
    await gateway.waitForIdle();

    const third = await openClient(url);
    const thirdChannel = inbox(third);
    await authenticate(third, thirdChannel);
    third.send(JSON.stringify(control('case.start', 'commit-three-case-start', {caseId: 'commit-three-case'})));
    await nextJson(thirdChannel, 'ack');
    third.send(start);
    const replayStart = await nextJson(thirdChannel, 'ack');
    assert.equal(replayStart.messageId, 'commit-three-start');

    third.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm));
    third.send(end);
    const durable = await nextJson(thirdChannel, 'ack');
    assert.equal(durable.messageId, 'commit-three-end');
    assert.equal(durable.durable, true);
    await gateway.waitForIdle();
    assert.equal(cases.snapshot('commit-three-case').speakers.A[0].state, 'saved');
    await closeClient(third);
  }, {gatewayOptions: {fileSystem}});
});

test('a recording orphaned by disconnect is terminal and does not block replacement A and B transcripts', async () => {
  await withGateway(async ({gateway, url, cases}) => {
    const first = await openClient(url);
    const firstChannel = inbox(first);
    await authenticate(first, firstChannel);
    first.send(JSON.stringify(control('case.start', 'orphan-case-start', {caseId: 'orphan-case'})));
    await nextJson(firstChannel, 'ack');
    first.send(startFrame({messageId: 'orphan-start', caseId: 'orphan-case', segmentId: 'orphan-a', speaker: 'A'}));
    await nextJson(firstChannel, 'ack');
    first.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([9, 0])));
    await closeClient(first);

    const second = await openClient(url);
    const channel = inbox(second);
    await authenticate(second, channel);
    assert.equal(cases.snapshot('orphan-case').speakers.A[0].state, 'failed');
    second.send(JSON.stringify(control('case.start', 'orphan-case-start', {caseId: 'orphan-case'})));
    await nextJson(channel, 'ack');
    for (const [segmentId, speaker] of [['replacement-a', 'A'], ['replacement-b', 'B']]) {
      second.send(startFrame({messageId: `${segmentId}-start`, caseId: 'orphan-case', segmentId, speaker}));
      await nextJson(channel, 'ack');
      second.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0, 2, 0])));
      second.send(endFrame({messageId: `${segmentId}-end`, caseId: 'orphan-case', segmentId, bytes: 4, lastSequence: 0}));
      assert.equal((await nextJson(channel, 'ack')).durable, true);
      await nextJson(channel, 'transcript.saved');
    }
    await gateway.waitForIdle();
    assert.equal(cases.snapshot('orphan-case').canMediate, true);
    await closeClient(second);
  });
});

test('retryable WAV persistence failure accepts exact replay and eventually returns durable ACK', async () => {
  let failRename = true;
  const fileSystem = {
    ...realFs,
    async rename(...args) {
      if (failRename && String(args[1]).endsWith('.wav')) {
        failRename = false;
        throw Object.assign(new Error('injected rename failure'), {code: 'EIO'});
      }
      return realFs.rename(...args);
    }
  };
  await withGateway(async ({gateway, url, cases}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'retry-write-case-start', {caseId: 'retry-write-case'})));
    await nextJson(channel, 'ack');
    const start = startFrame({messageId: 'retry-write-start', caseId: 'retry-write-case', segmentId: 'retry-write-a', speaker: 'A'});
    const end = endFrame({messageId: 'retry-write-end', caseId: 'retry-write-case', segmentId: 'retry-write-a', bytes: 4, lastSequence: 0});
    const pcm = Buffer.from([1, 0, 2, 0]);
    ws.send(start);
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm));
    ws.send(end);
    const failure = await nextJson(channel, 'error');
    assert.equal(failure.code, 'audio_write_failed');
    assert.equal(failure.caseId, 'retry-write-case');
    assert.equal(failure.segmentId, 'retry-write-a');

    ws.send(start);
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm));
    ws.send(end);
    const durable = await nextJson(channel, 'ack');
    assert.equal(durable.messageId, 'retry-write-end');
    assert.equal(durable.durable, true);
    await nextJson(channel, 'transcript.saved');
    await gateway.waitForIdle();
    assert.equal(cases.snapshot('retry-write-case').speakers.A[0].state, 'saved');
    await closeClient(ws);
  }, {gatewayOptions: {fileSystem}});
});

test('an exact completed-segment replay end releases the replay stream for the next recording', async () => {
  await withGateway(async ({gateway, url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'exact-case-start', {caseId: 'exact-case'})));
    await nextJson(channel, 'ack');

    const exactStart = startFrame({
      messageId: 'exact-start-a', caseId: 'exact-case', segmentId: 'exact-a', speaker: 'A'
    });
    const exactEnd = endFrame({
      messageId: 'exact-end-a', caseId: 'exact-case', segmentId: 'exact-a', bytes: 4, lastSequence: 0
    });
    const pcm = Buffer.from([1, 0, 2, 0]);
    ws.send(exactStart);
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm));
    ws.send(exactEnd);
    const originalDurable = await nextJson(channel, 'ack');
    assert.equal(originalDurable.durable, true);
    await nextJson(channel, 'transcript.saved');
    await gateway.waitForIdle();

    // Firmware reconnect replay deliberately preserves the original IDs.
    ws.send(exactStart);
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, pcm));
    ws.send(exactEnd);
    assert.deepEqual(await nextJson(channel, 'ack'), originalDurable);

    ws.send(startFrame({
      messageId: 'next-start-b', caseId: 'exact-case', segmentId: 'next-b', speaker: 'B'
    }));
    const nextStart = await nextJson(channel);
    assert.equal(nextStart.type, 'ack');
    assert.equal(nextStart.messageId, 'next-start-b');
    await closeClient(ws);
  });
});

test('segment replay rejects changed format, speaker, and case instead of returning an old ACK', async () => {
  await withGateway(async ({url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'binding-case-start', {caseId: 'binding-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'binding-start', caseId: 'binding-case', segmentId: 'bound-segment', speaker: 'A'}));
    await nextJson(channel, 'ack');
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([1, 0])));
    ws.send(endFrame({messageId: 'binding-end', caseId: 'binding-case', segmentId: 'bound-segment', bytes: 2, lastSequence: 0}));
    const durableAck = await nextJson(channel, 'ack');
    await nextJson(channel, 'transcript.saved');

    const changedFormat = control('speech.start', 'changed-format', {
      caseId: 'binding-case',
      segmentId: 'bound-segment',
      speaker: 'A',
      audio: {sampleRate: 8000, bits: 16, channels: 1}
    });
    ws.send(streamFrame(FrameKind.STREAM_START, 0, Buffer.from(JSON.stringify(changedFormat))));
    const formatConflict = await nextJson(channel, 'error');
    assert.equal(formatConflict.code, 'segment_conflict');

    ws.send(startFrame({messageId: 'changed-speaker', caseId: 'binding-case', segmentId: 'bound-segment', speaker: 'B'}));
    const speakerConflict = await nextJson(channel, 'error');
    assert.equal(speakerConflict.code, 'segment_conflict');
    assert.notDeepEqual(speakerConflict, durableAck);

    ws.send(JSON.stringify(control('case.start', 'replacement-case-start', {caseId: 'replacement-case'})));
    await nextJson(channel, 'ack');
    ws.send(startFrame({messageId: 'changed-case', caseId: 'replacement-case', segmentId: 'bound-segment', speaker: 'A'}));
    const caseConflict = await nextJson(channel, 'error');
    assert.equal(caseConflict.code, 'segment_conflict');
    assert.notDeepEqual(caseConflict, durableAck);
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

test('retries one failed mediation turn on a fresh Agent Stack session', async () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'retry-mediation-case');
  for (const [segmentId, speaker, transcript] of [
    ['retry-mediation-a', 'A', 'A 陈述'],
    ['retry-mediation-b', 'B', 'B 陈述']
  ]) {
    cases.startSegment({caseId: 'retry-mediation-case', segmentId, speaker, audio});
    cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
    cases.endSegment(segmentId);
    cases.saveTranscript(segmentId, transcript);
  }
  const mediation = {
    conflictSummary: '双方有分歧。',
    aPosition: 'A 的立场。',
    bPosition: 'B 的立场。',
    aCanImprove: 'A 可改进。',
    bCanImprove: 'B 可改进。',
    commonGround: '存在共同点。',
    suggestions: ['继续沟通。'],
    spokenText: '请双方继续沟通。'
  };
  const sessions = [];
  const turns = [];
  let ttsCalls = 0;

  await withGateway(async ({gateway, url}) => {
    const ws = await openClient(url);
    const channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'retry-mediation-start', {
      caseId: 'retry-mediation-case'
    })));
    await nextJson(channel, 'ack');
    ws.send(JSON.stringify(control('mediate.request', 'retry-mediation-request', {
      caseId: 'retry-mediation-case'
    })));
    await nextJson(channel, 'ack');
    await nextJson(channel, 'audio.end');
    await gateway.waitForIdle();

    assert.deepEqual(sessions, ['session-1', 'session-2']);
    assert.deepEqual(turns, ['session-1', 'session-2']);
    assert.equal(ttsCalls, 1);
    await closeClient(ws);
  }, {
    caseManager: cases,
    createMediatorSession: async () => {
      const sessionId = `session-${sessions.length + 1}`;
      sessions.push(sessionId);
      return sessionId;
    },
    mediatorService: {async mediate(_snapshot, sessionId) {
      turns.push(sessionId);
      if (turns.length === 1) throw new Error('transient mediation failure');
      return mediation;
    }},
    ttsService: {async synthesize() {
      ttsCalls += 1;
      return Buffer.from([1, 0, 2, 0]);
    }}
  });
});

test('bounds automatic mediation retry and a later request starts a third session', async () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'bounded-retry-case');
  for (const [segmentId, speaker] of [
    ['bounded-retry-a', 'A'], ['bounded-retry-b', 'B']
  ]) {
    cases.startSegment({caseId: 'bounded-retry-case', segmentId, speaker, audio});
    cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
    cases.endSegment(segmentId);
    cases.saveTranscript(segmentId, `${speaker} 陈述`);
  }
  const result = {
    conflictSummary: '双方有分歧。', aPosition: 'A 的立场。',
    bPosition: 'B 的立场。', aCanImprove: 'A 可改进。',
    bCanImprove: 'B 可改进。', commonGround: '存在共同点。',
    suggestions: ['继续沟通。'], spokenText: '请双方继续沟通。'
  };
  const sessions = [];
  const turns = [];
  let ttsCalls = 0;

  await withGateway(async ({gateway, url}) => {
    let ws = await openClient(url);
    let channel = inbox(ws);
    await authenticate(ws, channel);
    ws.send(JSON.stringify(control('case.start', 'bounded-retry-start', {
      caseId: 'bounded-retry-case'
    })));
    await nextJson(channel, 'ack');

    ws.send(JSON.stringify(control('mediate.request', 'bounded-retry-first', {
      caseId: 'bounded-retry-case'
    })));
    await nextJson(channel, 'ack');
    const failure = await nextJson(channel, 'error');
    assert.equal(failure.code, 'mediation_failed');
    await gateway.waitForIdle();
    assert.deepEqual(sessions, ['session-1', 'session-2']);
    assert.deepEqual(turns, ['session-1', 'session-2']);
    assert.equal(ttsCalls, 0);

    await closeClient(ws);
    ws = await openClient(url);
    channel = inbox(ws);
    await authenticate(ws, channel, token, 'device-1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(sessions, ['session-1', 'session-2']);
    assert.deepEqual(turns, ['session-1', 'session-2']);
    assert.equal(ttsCalls, 0);

    ws.send(JSON.stringify(control('mediate.request', 'bounded-retry-second', {
      caseId: 'bounded-retry-case'
    })));
    await nextJson(channel, 'ack');
    await nextJson(channel, 'audio.end');
    await gateway.waitForIdle();
    assert.deepEqual(sessions, ['session-1', 'session-2', 'session-3']);
    assert.deepEqual(turns, ['session-1', 'session-2', 'session-3']);
    assert.equal(ttsCalls, 1);
    await closeClient(ws);
  }, {
    caseManager: cases,
    createMediatorSession: async () => {
      const sessionId = `session-${sessions.length + 1}`;
      sessions.push(sessionId);
      return sessionId;
    },
    mediatorService: {async mediate(_snapshot, sessionId) {
      turns.push(sessionId);
      if (turns.length <= 2) throw new Error('persistent first-lane failure');
      return result;
    }},
    ttsService: {async synthesize() {
      ttsCalls += 1;
      return Buffer.from([1, 0]);
    }}
  });
});

test('a durable replacement request invalidates the old mediation lane before its commit finishes', async () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'lane-case');
  for (const [segmentId, speaker] of [['lane-a', 'A'], ['lane-b', 'B']]) {
    cases.startSegment({caseId: 'lane-case', segmentId, speaker, audio});
    cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
    cases.endSegment(segmentId);
    cases.saveTranscript(segmentId, `${speaker} 陈述`);
  }
  const result = {
    conflictSummary: '双方有分歧。', aPosition: 'A 的立场。',
    bPosition: 'B 的立场。', aCanImprove: 'A 可改进。',
    bCanImprove: 'B 可改进。', commonGround: '存在共同点。',
    suggestions: ['继续沟通。'], spokenText: '请继续沟通。'
  };
  const firstAttemptStarted = deferred();
  const firstAttempt = deferred();
  const replacementCommitStarted = deferred();
  const releaseReplacementCommit = deferred();
  let mediationCalls = 0;
  let sessionCalls = 0;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) {
      if (candidate.devices.some(({pendingMediation}) =>
        pendingMediation?.messageId === 'lane-replacement')) {
        replacementCommitStarted.resolve();
        await releaseReplacementCommit.promise;
      }
    }
  };

  await withGateway(async ({url}) => {
    let ws;
    try {
      ws = await openClient(url);
      const channel = inbox(ws);
      await authenticate(ws, channel);
      ws.send(JSON.stringify(control('case.start', 'lane-case-start', {caseId: 'lane-case'})));
      await nextJson(channel, 'ack');
      ws.send(JSON.stringify(control('mediate.request', 'lane-original', {caseId: 'lane-case'})));
      await nextJson(channel, 'ack');
      await settleWithin(firstAttemptStarted.promise);

      ws.send(JSON.stringify(control('mediate.request', 'lane-replacement', {caseId: 'lane-case'})));
      await settleWithin(replacementCommitStarted.promise);
      firstAttempt.reject(new Error('old lane failed'));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(mediationCalls, 1);
      assert.equal(sessionCalls, 1);

      releaseReplacementCommit.resolve();
      assert.equal((await nextJson(channel, 'ack')).messageId, 'lane-replacement');
      await nextJson(channel, 'audio.end');
      assert.equal(mediationCalls, 2);
      assert.equal(sessionCalls, 2);
      await closeClient(ws);
    } finally {
      firstAttempt.reject(new Error('test cleanup'));
      releaseReplacementCommit.resolve();
      if (ws) await closeClient(ws).catch(() => {});
    }
  }, {
    caseManager: cases,
    gatewayOptions: {stateStore},
    createMediatorSession: async () => `lane-session-${++sessionCalls}`,
    mediatorService: {async mediate() {
      mediationCalls += 1;
      if (mediationCalls === 1) {
        firstAttemptStarted.resolve();
        return firstAttempt.promise;
      }
      return result;
    }},
    ttsService: {async synthesize() { return Buffer.from([1, 0]); }}
  });
});

test('a request whose socket closes during its state commit remains pending without invoking mediation', async () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'disconnect-case');
  for (const [segmentId, speaker] of [['disconnect-a', 'A'], ['disconnect-b', 'B']]) {
    cases.startSegment({caseId: 'disconnect-case', segmentId, speaker, audio});
    cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
    cases.endSegment(segmentId);
    cases.saveTranscript(segmentId, `${speaker} 陈述`);
  }
  const commitStarted = deferred();
  const releaseCommit = deferred();
  let durableSnapshot;
  let mediationCalls = 0;
  const stateStore = {
    async cleanupParts() {},
    async load() { return null; },
    async commit(candidate) {
      durableSnapshot = structuredClone(candidate);
      if (candidate.devices.some(({pendingMediation}) =>
        pendingMediation?.messageId === 'disconnect-mediate')) {
        commitStarted.resolve();
        await releaseCommit.promise;
      }
    }
  };

  await withGateway(async ({gateway, url}) => {
    let ws;
    try {
      ws = await openClient(url);
      const channel = inbox(ws);
      await authenticate(ws, channel);
      ws.send(JSON.stringify(control('case.start', 'disconnect-case-start', {
        caseId: 'disconnect-case'
      })));
      await nextJson(channel, 'ack');
      ws.send(JSON.stringify(control('mediate.request', 'disconnect-mediate', {
        caseId: 'disconnect-case'
      })));
      await settleWithin(commitStarted.promise);

      const closed = new Promise((resolve) => ws.once('close', resolve));
      ws.terminate();
      await settleWithin(closed);
      releaseCommit.resolve();
      assert.equal(await gateway.waitForIdle({timeoutMs: 500}), true);

      assert.equal(mediationCalls, 0);
      assert.equal(durableSnapshot.devices[0].pendingMediation.messageId, 'disconnect-mediate');
    } finally {
      releaseCommit.resolve();
      if (ws) await closeClient(ws).catch(() => {});
    }
  }, {
    caseManager: cases,
    gatewayOptions: {stateStore},
    mediatorService: {async mediate() {
      mediationCalls += 1;
      return {
        conflictSummary: '双方有分歧。', aPosition: 'A 的立场。',
        bPosition: 'B 的立场。', aCanImprove: 'A 可改进。',
        bCanImprove: 'B 可改进。', commonGround: '存在共同点。',
        suggestions: ['继续沟通。'], spokenText: '请继续沟通。'
      };
    }},
    ttsService: {async synthesize() { return Buffer.from([1, 0]); }}
  });
});

test('reconnect detaches a stuck mediation and lets replacement mediation and transcription run', async () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'generation-case');
  for (const [segmentId, speaker, transcript] of [
    ['generation-a', 'A', 'A 陈述'],
    ['generation-b', 'B', 'B 陈述']
  ]) {
    cases.startSegment({caseId: 'generation-case', segmentId, speaker, audio});
    cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
    cases.endSegment(segmentId);
    cases.saveTranscript(segmentId, transcript);
  }
  const firstStarted = deferred();
  const makeResult = (spokenText) => ({
    conflictSummary: '双方有分歧。',
    aPosition: 'A 的立场。',
    bPosition: 'B 的立场。',
    aCanImprove: 'A 可改进。',
    bCanImprove: 'B 可改进。',
    commonGround: '存在共同点。',
    suggestions: ['继续沟通。'],
    spokenText
  });
  let mediationCalls = 0;
  let ttsCalls = 0;
  const mediatorService = {
    async mediate() {
      mediationCalls += 1;
      if (mediationCalls === 1) {
        firstStarted.resolve();
        return new Promise(() => {});
      }
      return makeResult('新连接结果');
    }
  };
  const ttsService = {
    async synthesize(text) {
      ttsCalls += 1;
      assert.equal(text, '新连接结果');
      return Buffer.from([2, 0, 3, 0]);
    }
  };

  await withGateway(async ({gateway, url}) => {
    const first = await openClient(url);
    const firstChannel = inbox(first);
    await authenticate(first, firstChannel);
    first.send(JSON.stringify(control('case.start', 'generation-case-start', {caseId: 'generation-case'})));
    await nextJson(firstChannel, 'ack');
    first.send(JSON.stringify(control('mediate.request', 'generation-m1', {caseId: 'generation-case'})));
    await nextJson(firstChannel, 'ack');
    await settleWithin(firstStarted.promise);
    await closeClient(first);

    const second = await openClient(url);
    const channel = inbox(second);
    await authenticate(second, channel);
    second.send(JSON.stringify(control('case.start', 'generation-case-start', {caseId: 'generation-case'})));
    await nextJson(channel, 'ack');
    second.send(JSON.stringify(control('mediate.request', 'generation-m2', {caseId: 'generation-case'})));
    await nextJson(channel, 'ack');

    const chunks = [];
    for (;;) {
      const message = await channel.next();
      if (message.isBinary) chunks.push(decodeBinaryFrame(message.value).payload);
      else if (message.value.type === 'audio.end') break;
      else if (message.value.type === 'error') assert.fail(message.value.code);
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([2, 0, 3, 0]));

    const extraStart = startFrame({
      messageId: 'generation-extra-start', caseId: 'generation-case',
      segmentId: 'generation-extra-a', speaker: 'A'
    });
    second.send(extraStart);
    await nextJson(channel, 'ack');
    second.send(streamFrame(FrameKind.STREAM_CHUNK, 0, Buffer.from([4, 0])));
    second.send(endFrame({
      messageId: 'generation-extra-end', caseId: 'generation-case',
      segmentId: 'generation-extra-a', bytes: 2, lastSequence: 0
    }));
    assert.equal((await nextJson(channel, 'ack')).durable, true);
    const saved = await nextJson(channel, 'transcript.saved');
    assert.equal(saved.segmentId, 'generation-extra-a');
    await gateway.waitForIdle();
    assert.equal(mediationCalls, 2);
    assert.equal(ttsCalls, 1);
    await closeClient(second);
  }, {caseManager: cases, mediatorService, ttsService});
});

test('rejects empty or over-capacity TTS PCM before publishing audio.start', async (t) => {
  for (const [name, voice] of [
    ['empty', Buffer.alloc(0)],
    ['over-capacity', Buffer.alloc(1_920_002)]
  ]) {
    await t.test(name, async () => {
      const cases = new CaseManager();
      const caseId = `tts-bound-${name}`;
      cases.startCase('device-1', caseId);
      for (const [segmentId, speaker] of [[`${name}-a`, 'A'], [`${name}-b`, 'B']]) {
        cases.startSegment({caseId, segmentId, speaker, audio});
        cases.appendChunk(segmentId, 0, Buffer.from([1, 0]));
        cases.endSegment(segmentId);
        cases.saveTranscript(segmentId, `${speaker} 陈述`);
      }
      const result = {
        conflictSummary: '双方有分歧。', aPosition: 'A 的立场。',
        bPosition: 'B 的立场。', aCanImprove: 'A 可改进。',
        bCanImprove: 'B 可改进。', commonGround: '存在共同点。',
        suggestions: ['继续沟通。'], spokenText: '请继续沟通。'
      };
      await withGateway(async ({url}) => {
        const ws = await openClient(url);
        const channel = inbox(ws);
        await authenticate(ws, channel);
        ws.send(JSON.stringify(control('case.start', `${name}-case-start`, {caseId})));
        await nextJson(channel, 'ack');
        ws.send(JSON.stringify(control('mediate.request', `${name}-mediate`, {caseId})));
        await nextJson(channel, 'ack');
        const error = await nextJson(channel, 'error');
        assert.equal(error.code, 'mediation_failed');
        await closeClient(ws);
      }, {
        caseManager: cases,
        mediatorService: {async mediate() { return result; }},
        ttsService: {async synthesize() { return voice; }}
      });
    });
  }
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
  const calls = {sessions: [], turns: [], mediationPayloads: [], active: 0, maxActive: 0};
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
      response.end(JSON.stringify({session: {
        sessionId: input.agentId === 'asr-agent' ? 'asr-session' : 'mediator-session'
      }}));
      return;
    }
    if (request.method === 'POST' && /^\/api\/sessions\/[^/]+\/turns(?:\/audio)?$/.test(request.url)) {
      const sessionId = request.url.split('/')[3];
      calls.active += 1;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      const isAsr = sessionId === 'asr-session';
      assert.equal(request.url, isAsr
        ? '/api/sessions/asr-session/turns/audio'
        : '/api/sessions/mediator-session/turns');
      if (!isAsr) {
        const input = JSON.parse(body.toString('utf8'));
        assert.deepEqual(Object.keys(input), ['input']);
        assert.deepEqual(Object.keys(input.input), ['type', 'text']);
        assert.equal(input.input.type, 'text');
        calls.mediationPayloads.push(serializedCaseFromPrompt(input.input.text));
      }
      calls.turns.push(isAsr ? `asr-${++asrNumber}` : 'mediator');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const assistantMessage = isAsr
        ? JSON.stringify({transcript: asrNumber === 1 ? 'A 的本地模拟陈述' : 'B 的本地模拟陈述', unclear: false})
        : JSON.stringify(mediation);
      response.writeHead(200, {'content-type': 'application/x-ndjson'});
      response.end(`${JSON.stringify({event: 'assistant_message', payload: {text: assistantMessage}})}\n${JSON.stringify({event: 'turn_finished', payload: {status: 'succeeded'}})}\n`);
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
    assert.equal(mock.calls.mediationPayloads.length, 1);
    const mediationInput = JSON.parse(mock.calls.mediationPayloads[0]);
    assert.match(mediationInput.caseId, /^fake-case-/);
    assert.equal(mock.calls.mediationPayloads[0], JSON.stringify({
      caseId: mediationInput.caseId,
      A: [{index: 1, text: 'A 的本地模拟陈述'}],
      B: [{index: 1, text: 'B 的本地模拟陈述'}],
      requirements: {neutral: true, noWinner: true, language: 'zh-CN'}
    }));
    assert.equal(mock.calls.maxActive, 1);
    assert.deepEqual(advertised, [{
      name: '小理本机 Bridge',
      host: 'xiaoli-bridge.local',
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

test('GET /healthz returns a local JSON response while unrelated HTTP routes remain rejected', async () => {
  let asrCalls = 0;
  let mediatorCalls = 0;
  let ttsCalls = 0;
  await withGateway(async ({gateway}) => {
    const address = gateway.address();
    const health = await httpGet(address.port, '/healthz');
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(health.body), {status: 'ok'});
    assert.equal((await httpGet(address.port, '/not-health')).statusCode, 404);
  }, {
    asrService: {async transcribe() { asrCalls += 1; }},
    mediatorService: {async mediate() { mediatorCalls += 1; }},
    ttsService: {async synthesize() { ttsCalls += 1; }}
  });
  assert.deepEqual({asrCalls, mediatorCalls, ttsCalls}, {asrCalls: 0, mediatorCalls: 0, ttsCalls: 0});
});

test('startBridge uses configured Xfyun RTASR before Agent Stack audio turns', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-xfyun-vertical-test-'));
  const mock = await startMockAgentStack();
  const outputPath = path.join(directory, 'xfyun-device-result.wav');
  const voice = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const transcripts = ['A 的讯飞转写', 'B 的讯飞转写'];
  const receivedPcm = [];
  const bonjour = {
    publish() { return {stop(callback) { callback?.(); }}; },
    destroy(callback) { callback?.(); }
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
        tempDir: directory,
        xfyunRtasr: {appId: 'test-app-id', apiKey: 'test-api-key-not-real'}
      },
      rtasrClient: {
        async transcribe(pcm) {
          receivedPcm.push(Buffer.from(pcm));
          return transcripts[receivedPcm.length - 1];
        }
      },
      ttsService: {async synthesize(text) {
        assert.equal(text, mock.mediation.spokenText);
        return voice;
      }},
      bonjourFactory: () => bonjour,
      logger: {info() {}, warn() {}, error() {}}
    });

    const result = await runFakeDevice({
      url: `ws://127.0.0.1:${bridge.address.port}/device`,
      token,
      outputPath
    });

    assert.equal(result.bytes, voice.length);
    assert.equal(receivedPcm.length, 2);
    assert.ok(receivedPcm.every((pcm) => pcm.length > 0 && pcm.length % 2 === 0));
    assert.deepEqual(mock.calls.sessions, ['mediator-agent']);
    assert.deepEqual(mock.calls.turns, ['mediator']);
    assert.equal(mock.calls.mediationPayloads.length, 1);
    assert.equal(mock.calls.mediationPayloads[0], JSON.stringify({
      caseId: JSON.parse(mock.calls.mediationPayloads[0]).caseId,
      A: [{index: 1, text: transcripts[0]}],
      B: [{index: 1, text: transcripts[1]}],
      requirements: {neutral: true, noWinner: true, language: 'zh-CN'}
    }));
  } finally {
    await bridge?.shutdown();
    await mock.close();
    await rm(directory, {recursive: true, force: true});
  }
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
          ws.send(JSON.stringify({v: 1, type: 'hello.ack', messageId: message.messageId, deviceId: 'other-device', protocol: 1}));
          ws.send(JSON.stringify({v: 1, type: 'hello.ack', messageId: message.messageId, deviceId: message.deviceId, protocol: 1}));
        } else if (message.type === 'case.start') {
          ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: 'other-case', accepted: true}));
          ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true}));
        } else if (message.type === 'mediate.request') {
          clearTimeout(failsafe);
          ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: 'other-case', accepted: true}));
          ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true}));
          ws.send(JSON.stringify({v: 1, type: 'audio.start', caseId: 'other-case', audio, bytes: voice.length}));
          ws.send(JSON.stringify({v: 1, type: 'audio.end', caseId: 'other-case', bytes: 0, lastSequence: 0, complete: true}));
          ws.send(JSON.stringify({v: 1, type: 'audio.start', caseId: message.caseId, audio, bytes: voice.length}));
          ws.send(encodeBinaryFrame({kind: FrameKind.STREAM_CHUNK, streamType: 0, flags: 0, sequence: 0, payload: voice}));
          ws.send(JSON.stringify({v: 1, type: 'audio.end', caseId: message.caseId, bytes: voice.length, lastSequence: 0, complete: true}));
        }
        return;
      }
      const frame = decodeBinaryFrame(data);
      if (frame.kind === FrameKind.STREAM_START) {
        const message = JSON.parse(frame.payload.toString('utf8'));
        ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: 'other-case', segmentId: message.segmentId, accepted: true}));
        ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, segmentId: message.segmentId, accepted: true}));
      } else if (frame.kind === FrameKind.STREAM_END) {
        const message = JSON.parse(frame.payload.toString('utf8'));
        ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, segmentId: 'other-segment', bytes: message.bytes, durable: true}));
        ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, segmentId: message.segmentId, bytes: message.bytes, durable: true}));
        ws.send(JSON.stringify({v: 1, type: 'transcript.saved', caseId: 'other-case', segmentId: message.segmentId, speaker: message.segmentId.startsWith('a-') ? 'A' : 'B'}));
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

async function withFakePlaybackServer(playback, run) {
  const wss = new WebSocketServer({host: '127.0.0.1', port: 0, path: '/device'});
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  wss.on('connection', (ws) => {
    const speakers = new Map();
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const message = JSON.parse(data.toString('utf8'));
        if (message.type === 'hello') {
          ws.send(JSON.stringify({v: 1, type: 'hello.ack', messageId: message.messageId, deviceId: message.deviceId, protocol: 1}));
        } else if (message.type === 'case.start') {
          ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true}));
        } else if (message.type === 'mediate.request') {
          ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true}));
          playback(ws, message.caseId);
        }
        return;
      }
      const frame = decodeBinaryFrame(data);
      if (frame.kind === FrameKind.STREAM_START) {
        const message = JSON.parse(frame.payload.toString('utf8'));
        speakers.set(message.segmentId, message.speaker);
        ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, segmentId: message.segmentId, accepted: true}));
      } else if (frame.kind === FrameKind.STREAM_END) {
        const message = JSON.parse(frame.payload.toString('utf8'));
        ws.send(JSON.stringify({v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, segmentId: message.segmentId, bytes: message.bytes, durable: true}));
        ws.send(JSON.stringify({
          v: 1,
          type: 'transcript.saved',
          caseId: message.caseId,
          segmentId: message.segmentId,
          speaker: speakers.get(message.segmentId)
        }));
      }
    });
  });
  const address = wss.address();
  try {
    await run(`ws://127.0.0.1:${address.port}/device`);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
}

test('fake device rejects duplicate or wrong-format matching audio.start events', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-fake-start-oracle-'));
  const voice = Buffer.from([1, 0, 2, 0]);
  try {
    await t.test('duplicate matching start', async () => {
      await withFakePlaybackServer((ws, caseId) => {
        const start = {v: 1, type: 'audio.start', caseId, audio, bytes: voice.length};
        ws.send(JSON.stringify(start));
        ws.send(JSON.stringify(start));
        ws.send(encodeBinaryFrame({kind: FrameKind.STREAM_CHUNK, streamType: 0, flags: 0, sequence: 0, payload: voice}));
        ws.send(JSON.stringify({v: 1, type: 'audio.end', caseId, bytes: voice.length, lastSequence: 0, complete: true}));
      }, async (url) => {
        await assert.rejects(() => runFakeDevice({url, token, outputPath: path.join(directory, 'duplicate.wav')}), /audio\.start|exactly one|duplicate/i);
      });
    });
    await t.test('wrong matching format', async () => {
      await withFakePlaybackServer((ws, caseId) => {
        ws.send(JSON.stringify({v: 1, type: 'audio.start', caseId, audio: {...audio, sampleRate: 8000}, bytes: voice.length}));
        ws.send(encodeBinaryFrame({kind: FrameKind.STREAM_CHUNK, streamType: 0, flags: 0, sequence: 0, payload: voice}));
        ws.send(JSON.stringify({v: 1, type: 'audio.end', caseId, bytes: voice.length, lastSequence: 0, complete: true}));
      }, async (url) => {
        await assert.rejects(() => runFakeDevice({url, token, outputPath: path.join(directory, 'format.wav')}), /audio\.start|format|16000/i);
      });
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('fake device rejects audio.end metadata inconsistent with received PCM', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-fake-end-oracle-'));
  const voice = Buffer.from([1, 0, 2, 0]);
  try {
    await withFakePlaybackServer((ws, caseId) => {
      ws.send(JSON.stringify({v: 1, type: 'audio.start', caseId, audio, bytes: voice.length}));
      ws.send(encodeBinaryFrame({kind: FrameKind.STREAM_CHUNK, streamType: 0, flags: 0, sequence: 0, payload: voice}));
      ws.send(JSON.stringify({v: 1, type: 'audio.end', caseId, bytes: voice.length + 2, lastSequence: 4, complete: false}));
    }, async (url) => {
      await assert.rejects(() => runFakeDevice({url, token, outputPath: path.join(directory, 'bad-end.wav')}), /audio\.end|completion|metadata/i);
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('fake device rejects discontinuous or oversized voice chunks', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-fake-chunk-oracle-'));
  try {
    await t.test('discontinuous sequence', async () => {
      const voice = Buffer.from([1, 0, 2, 0]);
      await withFakePlaybackServer((ws, caseId) => {
        ws.send(JSON.stringify({v: 1, type: 'audio.start', caseId, audio, bytes: voice.length}));
        ws.send(encodeBinaryFrame({kind: FrameKind.STREAM_CHUNK, streamType: 0, flags: 0, sequence: 1, payload: voice}));
      }, async (url) => {
        await assert.rejects(() => runFakeDevice({url, token, outputPath: path.join(directory, 'gap.wav')}), /voice chunk|sequence/i);
      });
    });
    await t.test('oversized payload', async () => {
      const voice = Buffer.alloc(4_098);
      await withFakePlaybackServer((ws, caseId) => {
        ws.send(JSON.stringify({v: 1, type: 'audio.start', caseId, audio, bytes: voice.length}));
        ws.send(encodeBinaryFrame({kind: FrameKind.STREAM_CHUNK, streamType: 0, flags: 0, sequence: 0, payload: voice}));
      }, async (url) => {
        await assert.rejects(() => runFakeDevice({url, token, outputPath: path.join(directory, 'oversized.wav')}), /voice chunk|4096|invalid/i);
      });
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
