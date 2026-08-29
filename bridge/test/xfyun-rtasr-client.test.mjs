import assert from 'node:assert/strict';
import {EventEmitter, getEventListeners} from 'node:events';
import test from 'node:test';
import {XfyunRtasrClient} from '../src/xfyun/rtasr-client.mjs';

class FakeWebSocket extends EventEmitter {
  static instances = [];

  static reset() {
    this.instances = [];
  }

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(frame) {
    this.sent.push(frame);
    this.onSend?.(frame);
  }

  close() {
    this.closeCalls += 1;
  }

  terminate() {
    this.terminateCalls += 1;
  }
}

function message(socket, payload) {
  socket.emit('message', Buffer.from(JSON.stringify(payload)));
}

function result(segId, text, type = '0', code = '0') {
  return {
    action: 'result',
    code,
    data: JSON.stringify({
      seg_id: segId,
      cn: {
        st: {
          type,
          rt: [{ws: text.split('').map((w) => ({cw: [{w}]}))}]
        }
      }
    })
  };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

function isEndFrame(frame) {
  return Buffer.isBuffer(frame) && frame.toString('utf8') === '{"end": true}';
}

async function waitForEndFrame(socket) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (socket.sent.at(-1)?.toString('utf8') === '{"end": true}') return;
    await nextTurn();
  }
  throw new Error('audio stream did not send its end frame');
}

function createClient(overrides = {}) {
  return new XfyunRtasrClient({
    appId: 'test-app',
    apiKey: 'test-key',
    WebSocketImpl: FakeWebSocket,
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    handshakeTimeoutMs: 50,
    resultTimeoutMs: 50,
    ...overrides
  });
}

test('accepts string success codes, streams binary PCM, and waits for close to aggregate final segments', async () => {
  FakeWebSocket.reset();
  const delays = [];
  const signal = new AbortController().signal;
  const client = createClient({
    sleep: async (milliseconds, suppliedSignal) => {
      delays.push({milliseconds, suppliedSignal});
    }
  });
  const pcm = Buffer.alloc(2562, 7);
  const pending = client.transcribe(pcm, {signal});
  const socket = FakeWebSocket.instances[0];

  const parsed = new URL(socket.url);
  assert.equal(parsed.origin, 'wss://rtasr.xfyun.cn');
  assert.equal(parsed.pathname, '/v1/ws');
  assert.equal(parsed.searchParams.get('appid'), 'test-app');
  assert.equal(parsed.searchParams.get('ts'), '1700000000');
  // Fixed expected value for appid="test-app", ts=1700000000, and key="test-key".
  assert.equal(parsed.searchParams.get('signa'), '2RJndfgpUCMjT0agTHRPj7G6Zu4=');

  socket.onSend = (frame) => {
    if (socket.sent.length <= 3) assert.ok(Buffer.isBuffer(frame));
  };
  message(socket, {action: 'started', code: '0'});
  await waitForEndFrame(socket);

  let completed = false;
  void pending.then(() => { completed = true; }, () => { completed = true; });
  message(socket, result(1, '你'));
  await nextTurn();
  assert.equal(completed, false);
  message(socket, result(2, '界'));
  socket.emit('close', 1000, 'complete');

  assert.equal(await pending, '你界');
  assert.equal(socket.sent.length, 4);
  assert.deepEqual(socket.sent.slice(0, 3).map((frame) => frame.length), [1280, 1280, 2]);
  assert.ok(socket.sent.slice(0, 3).every(Buffer.isBuffer));
  assert.ok(Buffer.isBuffer(socket.sent[3]));
  assert.equal(socket.sent[3].toString('utf8'), '{"end": true}');
  assert.deepEqual(JSON.parse(socket.sent[3].toString('utf8')), {end: true});
  assert.deepEqual(delays, [
    {milliseconds: 40, suppliedSignal: signal},
    {milliseconds: 40, suppliedSignal: signal},
    {milliseconds: 40, suppliedSignal: signal}
  ]);
});

test('paces the final PCM frame before sending the binary end marker', async () => {
  FakeWebSocket.reset();
  let releaseFinalFrame;
  const finalFrameDelay = new Promise((resolve) => { releaseFinalFrame = resolve; });
  const client = createClient({sleep: () => finalFrameDelay});
  const pending = client.transcribe(Buffer.from([1, 2]));
  const socket = FakeWebSocket.instances[0];

  message(socket, {action: 'started', code: 0});
  await nextTurn();
  assert.equal(socket.sent.length, 1);
  assert.equal(isEndFrame(socket.sent[0]), false);

  releaseFinalFrame();
  await waitForEndFrame(socket);
  message(socket, result(1, '好'));
  socket.emit('close');
  assert.equal(await pending, '好');
});

test('replaces duplicate final segments by seg_id before the completed connection closes', async () => {
  FakeWebSocket.reset();
  const pending = createClient().transcribe(Buffer.from([1, 2]));
  const socket = FakeWebSocket.instances[0];
  message(socket, {action: 'started', code: 0});
  await waitForEndFrame(socket);
  message(socket, result(2, '界'));
  message(socket, result(1, '你'));
  message(socket, result(1, '好'));
  socket.emit('close');
  assert.equal(await pending, '好界');
});

test('parses official top-level seg_id, numeric final types, and the preferred word candidate', async () => {
  FakeWebSocket.reset();
  const pending = createClient().transcribe(Buffer.from([1, 2]));
  const socket = FakeWebSocket.instances[0];
  message(socket, {action: 'started', code: '0'});
  await waitForEndFrame(socket);
  message(socket, {
    action: 'result',
    code: '0',
    data: JSON.stringify({
      seg_id: 7,
      cn: {st: {type: 0, rt: [{ws: [{cw: [{w: '首选'}, {w: '备选'}]}]}]}}
    })
  });
  socket.emit('close');
  assert.equal(await pending, '首选');
});

test('rejects invalid PCM input before opening a socket', async () => {
  FakeWebSocket.reset();
  const client = createClient();
  await assert.rejects(() => client.transcribe(Buffer.from([1])), /even.*byte/i);
  await assert.rejects(() => client.transcribe(new Uint8Array([1, 2])), /Buffer/i);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('rejects and sanitizes server-side failures without leaking credentials or raw payloads', async () => {
  FakeWebSocket.reset();
  const client = createClient();
  const pending = client.transcribe(Buffer.from([1, 2]));
  const socket = FakeWebSocket.instances[0];
  message(socket, {action: 'error', code: 101, desc: 'upstream test-key app=test-app data=private'});
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /service/i);
    assert.equal(error.upstreamCode, '101');
    assert.doesNotMatch(error.message, /test-key|test-app|private|101/);
    return true;
  });
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.closeCalls, 0);
});

test('rejects parsed non-object messages inside the listener without throwing synchronously', async () => {
  FakeWebSocket.reset();
  for (const raw of ['null', '[]', '"text"', '42']) {
    const pending = createClient().transcribe(Buffer.from([1, 2]));
    const socket = FakeWebSocket.instances.at(-1);
    assert.doesNotThrow(() => socket.emit('message', Buffer.from(raw)));
    await assert.rejects(pending, /invalid response/i);
    assert.equal(socket.terminateCalls, 1);
    assert.equal(socket.closeCalls, 0);
  }
});

test('rejects parsed non-object result data promptly and releases the socket', async () => {
  FakeWebSocket.reset();
  for (const data of ['null', '[]', '"text"', '42']) {
    const pending = createClient().transcribe(Buffer.from([1, 2]));
    const socket = FakeWebSocket.instances.at(-1);
    message(socket, {action: 'started', code: 0});
    await waitForEndFrame(socket);
    assert.doesNotThrow(() => message(socket, {action: 'result', code: 0, data}));
    await assert.rejects(pending, /invalid result/i);
    assert.equal(socket.terminateCalls, 1);
    assert.equal(socket.closeCalls, 0);
  }
});

test('uses UNKNOWN for missing or unsafe upstream codes', async () => {
  FakeWebSocket.reset();
  const client = createClient();
  const invalidPending = client.transcribe(Buffer.from([1, 2]));
  message(FakeWebSocket.instances[0], {action: 'error', code: '101 private', desc: 'test-key'});
  await assert.rejects(invalidPending, (error) => {
    assert.equal(error.upstreamCode, 'UNKNOWN');
    assert.doesNotMatch(error.message, /101|private|test-key/);
    return true;
  });

  const missingPending = client.transcribe(Buffer.from([1, 2]));
  message(FakeWebSocket.instances[1], {action: 'error', desc: 'test-key'});
  await assert.rejects(missingPending, (error) => {
    assert.equal(error.upstreamCode, 'UNKNOWN');
    return true;
  });
});

test('rejects abnormal started codes and a close before completion', async () => {
  FakeWebSocket.reset();
  const client = createClient();
  const codePending = client.transcribe(Buffer.from([1, 2]));
  message(FakeWebSocket.instances[0], {action: 'started', code: 9, desc: 'test-key'});
  await assert.rejects(codePending, (error) => {
    assert.match(error.message, /handshake/i);
    assert.equal(error.upstreamCode, '9');
    return true;
  });

  const closePending = client.transcribe(Buffer.from([1, 2]));
  const socket = FakeWebSocket.instances[1];
  message(socket, {action: 'started', code: 0});
  await nextTurn();
  socket.emit('close', 1006, 'untrusted server data');
  await assert.rejects(closePending, (error) => {
    assert.match(error.message, /closed/i);
    assert.doesNotMatch(error.message, /untrusted|1006/);
    return true;
  });
});

test('rejects empty final output and result timeout', async () => {
  FakeWebSocket.reset();
  const client = createClient({resultTimeoutMs: 15});
  const emptyPending = client.transcribe(Buffer.from([1, 2]));
  const emptySocket = FakeWebSocket.instances[0];
  emptySocket.onSend = (frame) => {
    if (isEndFrame(frame)) {
      message(emptySocket, result(1, '', '0'));
      emptySocket.emit('close');
    }
  };
  message(emptySocket, {action: 'started', code: 0});
  await assert.rejects(emptyPending, /empty/i);

  const timeoutPending = client.transcribe(Buffer.from([1, 2]));
  const timeoutSocket = FakeWebSocket.instances[1];
  message(timeoutSocket, {action: 'started', code: 0});
  await assert.rejects(timeoutPending, /timed out/i);
  assert.equal(timeoutSocket.terminateCalls, 1);
  assert.equal(timeoutSocket.closeCalls, 0);
});

test('rejects promptly with AbortError and terminates its socket', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const pending = createClient().transcribe(Buffer.from([1, 2]), {signal: controller.signal});
  const socket = FakeWebSocket.instances[0];
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.closeCalls, 0);
});

test('terminates handshake, socket, and audio-transport failures before allowing another call', async () => {
  FakeWebSocket.reset();
  const handshakePending = createClient({handshakeTimeoutMs: 5}).transcribe(Buffer.from([1, 2]));
  const handshakeSocket = FakeWebSocket.instances[0];
  await assert.rejects(handshakePending, /handshake timed out/i);
  assert.equal(handshakeSocket.terminateCalls, 1);

  const connectionPending = createClient().transcribe(Buffer.from([1, 2]));
  const connectionSocket = FakeWebSocket.instances[1];
  connectionSocket.emit('error', new Error('private socket detail'));
  await assert.rejects(connectionPending, /connection failed/i);
  assert.equal(connectionSocket.terminateCalls, 1);

  const audioPending = createClient().transcribe(Buffer.from([1, 2]));
  const audioSocket = FakeWebSocket.instances[2];
  audioSocket.onSend = () => { throw new Error('private transport detail'); };
  message(audioSocket, {action: 'started', code: 0});
  await assert.rejects(audioPending, /audio transport failed/i);
  assert.equal(audioSocket.terminateCalls, 1);

  const nextPending = createClient().transcribe(Buffer.from([1, 2]));
  const nextSocket = FakeWebSocket.instances[3];
  assert.deepEqual(FakeWebSocket.instances.slice(0, 3).map((socket) => socket.terminateCalls), [1, 1, 1]);
  message(nextSocket, {action: 'started', code: 0});
  await waitForEndFrame(nextSocket);
  message(nextSocket, result(1, '新'));
  nextSocket.emit('close');
  assert.equal(await nextPending, '新');
  assert.equal(nextSocket.terminateCalls, 0);
});

test('stops a paced audio sender after a service failure releases its socket', async () => {
  FakeWebSocket.reset();
  let resumeSleep;
  const sleepStarted = new Promise((resolve) => {
    resumeSleep = () => resolve();
  });
  const client = createClient({sleep: () => sleepStarted});
  const pending = client.transcribe(Buffer.alloc(2560, 1));
  const socket = FakeWebSocket.instances[0];
  socket.onSend = () => {
    if (socket.sent.length === 1) message(socket, {action: 'error', code: 101});
  };
  message(socket, {action: 'started', code: 0});

  await assert.rejects(pending, /service rejected/i);
  assert.equal(socket.terminateCalls, 1);
  resumeSleep();
  await nextTurn();
  assert.equal(socket.sent.length, 1);
});

test('removes default sleep abort listeners when each frame delay resolves normally', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const client = new XfyunRtasrClient({
    appId: 'test-app',
    apiKey: 'test-key',
    WebSocketImpl: FakeWebSocket,
    now: () => 1_700_000_000_000,
    handshakeTimeoutMs: 100,
    resultTimeoutMs: 100
  });
  const pending = client.transcribe(Buffer.alloc(2560, 1), {signal: controller.signal});
  const socket = FakeWebSocket.instances[0];
  socket.onSend = (frame) => {
    if (isEndFrame(frame)) {
      message(socket, result(1, '好'));
      socket.emit('close');
    }
  };
  message(socket, {action: 'started', code: '0'});
  assert.equal(await pending, '好');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
