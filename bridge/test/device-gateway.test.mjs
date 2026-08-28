import assert from 'node:assert/strict';
import {createServer} from 'node:http';
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
    assert.deepEqual(await readdir(tempDir), []);
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
    assert.deepEqual(await readdir(tempDir), []);
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
    for (let sequence = 0; sequence < 30; sequence += 1) {
      ws.send(streamFrame(FrameKind.STREAM_CHUNK, sequence, Buffer.alloc(64_000)));
    }
    ws.send(streamFrame(FrameKind.STREAM_CHUNK, 30, Buffer.alloc(2)));

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
      renameStarted.resolve();
      await releaseRename.promise;
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
    assert.deepEqual(await readdir(tempDir), []);
    releaseRename.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(asrCalls, 0);
    assert.deepEqual(await readdir(tempDir), []);
  }, {
    asrService: {async transcribe() { asrCalls += 1; return 'must not transcribe'; }},
    gatewayOptions: {fileSystem}
  });
});

test('shutdown aborts never-resolving ASR, closes clients, and removes its durable WAV within a bound', async () => {
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
    assert.deepEqual(await readdir(tempDir), []);
  }, {asrService});
});

test('default cancellation grace covers child termination and retries every owned temp cleanup within five seconds', async () => {
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
    assert.ok(wavRemoveAttempts >= 3);
    assert.deepEqual(await readdir(tempDir), []);
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
    assert.deepEqual(await readdir(tempDir), []);
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
      await rm(wavPath);
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
