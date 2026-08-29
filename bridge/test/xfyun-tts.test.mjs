import assert from 'node:assert/strict';
import {EventEmitter, getEventListeners} from 'node:events';
import test from 'node:test';
import {XfyunTts} from '../src/tts/xfyun-tts.mjs';

class FakeWebSocket extends EventEmitter {
  static instances = [];

  static reset() {
    this.instances = [];
  }

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
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
  socket.emit('message', Buffer.from(JSON.stringify(payload)), false);
}

function rawMessage(socket, payload) {
  socket.emit('message', Buffer.from(payload), false);
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

function createTts(overrides = {}) {
  return new XfyunTts({
    appId: 'test-app',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    WebSocketImpl: FakeWebSocket,
    now: () => 1_700_000_000_000,
    timeoutMs: 50,
    ...overrides
  });
}

test('signs the v2 TTS request, sends UTF-8 text, and aggregates raw 16 kHz PCM', async () => {
  FakeWebSocket.reset();
  const pending = createTts().synthesize('你好');
  const socket = FakeWebSocket.instances[0];
  const url = new URL(socket.url);

  assert.equal(url.origin, 'wss://tts-api.xfyun.cn');
  assert.equal(url.pathname, '/v2/tts');
  assert.equal(url.searchParams.get('host'), 'tts-api.xfyun.cn');
  assert.equal(url.searchParams.get('date'), 'Tue, 14 Nov 2023 22:13:20 GMT');
  assert.equal(socket.options.maxPayload, 2_625_536);
  assert.equal(
    Buffer.from(url.searchParams.get('authorization'), 'base64').toString('utf8'),
    'api_key="test-key", algorithm="hmac-sha256", headers="host date request-line", signature="Dq8aVaDsNvxNohIQ+EYzuHFGOGuvv1eDMshUM/drMJI="'
  );

  await nextTurn();
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    common: {app_id: 'test-app'},
    business: {
      aue: 'raw',
      auf: 'audio/L16;rate=16000',
      vcn: 'x4_xiaoyan',
      speed: 50,
      volume: 50,
      pitch: 50,
      tte: 'UTF8'
    },
    data: {
      status: 2,
      text: Buffer.from('你好', 'utf8').toString('base64')
    }
  });

  message(socket, {
    code: 0,
    message: 'success',
    sid: 'tts-session-1',
    data: {audio: Buffer.from([1, 0]).toString('base64'), status: 1, ced: '3'}
  });
  message(socket, {
    code: 0,
    message: 'success',
    data: {audio: Buffer.from([2, 0]).toString('base64'), status: 2, ced: '6'}
  });

  assert.deepEqual(await pending, Buffer.from([1, 0, 2, 0]));
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.terminateCalls, 0);
});

test('validates voice settings at construction and updates them atomically', () => {
  for (const [name, value] of [
    ['voice', ''],
    ['voice', '../unsafe'],
    ['speed', -1],
    ['speed', 101],
    ['volume', 50.5],
    ['pitch', '50']
  ]) {
    assert.throws(() => createTts({[name]: value}), new RegExp(name, 'i'));
  }

  const tts = createTts();
  const initial = tts.getVoiceSettings();
  assert.deepEqual(initial, {voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50});
  initial.speed = 1;
  assert.deepEqual(tts.getVoiceSettings(), {
    voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50
  });

  assert.deepEqual(tts.updateVoiceSettings({voice: 'x4_yezi', speed: 65}), {
    voice: 'x4_yezi', speed: 65, volume: 50, pitch: 50
  });
  assert.throws(() => tts.updateVoiceSettings({volume: 101}), /volume/i);
  assert.deepEqual(tts.getVoiceSettings(), {
    voice: 'x4_yezi', speed: 65, volume: 50, pitch: 50
  });
});

test('each synthesis snapshots voice settings before its WebSocket opens', async () => {
  FakeWebSocket.reset();
  const tts = createTts({voice: 'x4_yezi', speed: 40, volume: 60, pitch: 30});
  const first = tts.synthesize('第一次');
  const firstSocket = FakeWebSocket.instances[0];
  tts.updateVoiceSettings({voice: 'x4_xiaoyan', speed: 70});

  await nextTurn();
  assert.deepEqual(JSON.parse(firstSocket.sent[0]).business, {
    aue: 'raw',
    auf: 'audio/L16;rate=16000',
    vcn: 'x4_yezi',
    speed: 40,
    volume: 60,
    pitch: 30,
    tte: 'UTF8'
  });
  message(firstSocket, {
    code: 0,
    sid: 'settings-session-1',
    data: {audio: Buffer.from([1, 0]).toString('base64'), status: 2}
  });
  await first;

  const second = tts.synthesize('第二次');
  const secondSocket = FakeWebSocket.instances[1];
  await nextTurn();
  assert.deepEqual(JSON.parse(secondSocket.sent[0]).business, {
    aue: 'raw',
    auf: 'audio/L16;rate=16000',
    vcn: 'x4_xiaoyan',
    speed: 70,
    volume: 60,
    pitch: 30,
    tte: 'UTF8'
  });
  message(secondSocket, {
    code: 0,
    sid: 'settings-session-2',
    data: {audio: Buffer.from([2, 0]).toString('base64'), status: 2}
  });
  await second;
});

test('rejects missing credentials and invalid text before opening a socket', async () => {
  FakeWebSocket.reset();
  await assert.rejects(
    () => new XfyunTts({WebSocketImpl: FakeWebSocket}).synthesize('调解内容'),
    /credentials.*required/i
  );
  await assert.rejects(() => createTts().synthesize('   '), /non-empty string/i);
  await assert.rejects(() => createTts().synthesize(new Uint8Array([1, 2])), /text.*string/i);
  await assert.rejects(() => createTts().synthesize('a'.repeat(8000)), /8000.*bytes/i);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('surfaces only a safe numeric upstream code when the service rejects synthesis', async () => {
  FakeWebSocket.reset();
  const spokenText = 'private mediation text';
  const pending = createTts().synthesize(spokenText);
  const socket = FakeWebSocket.instances[0];
  message(socket, {
    code: 11200,
    message: `test-key test-secret test-app ${spokenText}`,
    sid: 'private-session'
  });

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /service rejected/i);
    assert.equal(error.upstreamCode, '11200');
    assert.doesNotMatch(error.message, /test-key|test-secret|test-app|private|11200/i);
    return true;
  });
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.closeCalls, 0);
});

test('rejects missing or unsafe response codes without exposing their contents', async () => {
  FakeWebSocket.reset();
  for (const code of [undefined, '11200 private']) {
    const pending = createTts().synthesize('调解内容');
    const socket = FakeWebSocket.instances.at(-1);
    message(socket, {code, message: 'test-secret private'});
    await assert.rejects(pending, (error) => {
      assert.match(error.message, /invalid response/i);
      assert.doesNotMatch(error.message, /test-secret|private|11200/i);
      return true;
    });
  }
});

test('rejects numeric strings because the official response code is an integer', async () => {
  FakeWebSocket.reset();
  for (const code of ['0', '11200']) {
    const pending = createTts().synthesize('调解内容');
    const socket = FakeWebSocket.instances.at(-1);
    message(socket, {
      code,
      sid: 'string-code-session',
      data: {audio: Buffer.from([1, 0]).toString('base64'), status: 2}
    });
    await assert.rejects(pending, /invalid response code/i);
    assert.equal(socket.terminateCalls, 1);
  }
});

test('rejects malformed envelopes instead of treating them as service responses', async () => {
  FakeWebSocket.reset();
  for (const raw of ['not-json', 'null', '[]', '"text"']) {
    const pending = createTts().synthesize('调解内容');
    const socket = FakeWebSocket.instances.at(-1);
    assert.doesNotThrow(() => rawMessage(socket, raw));
    await assert.rejects(pending, /invalid response/i);
    assert.equal(socket.terminateCalls, 1);
  }
});

test('requires a safe first-frame sid and rejects a changed sid', async () => {
  FakeWebSocket.reset();
  const finalData = {audio: Buffer.from([1, 0]).toString('base64'), status: 2};

  for (const sid of [undefined, '', 'line\nbreak']) {
    const pending = createTts().synthesize('调解内容');
    const socket = FakeWebSocket.instances.at(-1);
    message(socket, {code: 0, sid, data: finalData});
    await assert.rejects(pending, /invalid.*sid/i);
    assert.equal(socket.terminateCalls, 1);
  }

  const changedPending = createTts().synthesize('调解内容');
  const changedSocket = FakeWebSocket.instances.at(-1);
  message(changedSocket, {
    code: 0,
    sid: 'session-one',
    data: {audio: Buffer.from([1, 0]).toString('base64'), status: 1}
  });
  message(changedSocket, {
    code: 0,
    sid: 'session-two',
    data: finalData
  });
  await assert.rejects(changedPending, /invalid.*sid/i);
  assert.equal(changedSocket.terminateCalls, 1);
});

test('rejects missing and non-numeric stream status values', async () => {
  FakeWebSocket.reset();
  for (const status of [undefined, 0, 3, '2']) {
    const pending = createTts().synthesize('调解内容');
    const socket = FakeWebSocket.instances.at(-1);
    message(socket, {
      code: 0,
      sid: 'status-session',
      data: {audio: Buffer.from([1, 0]).toString('base64'), status}
    });
    await assert.rejects(pending, /invalid.*status/i);
    assert.equal(socket.terminateCalls, 1);
  }
});

test('rejects invalid, empty, and odd-length PCM output', async () => {
  FakeWebSocket.reset();
  for (const audio of ['%%%', '', Buffer.from([1]).toString('base64')]) {
    const pending = createTts().synthesize('调解内容');
    const socket = FakeWebSocket.instances.at(-1);
    message(socket, {code: 0, sid: 'audio-session', data: {audio, status: 2}});
    await assert.rejects(pending, /invalid|empty|even/i);
    assert.equal(socket.terminateCalls, 1);
  }
});

test('terminates the response as soon as accumulated PCM exceeds its configured limit', async () => {
  FakeWebSocket.reset();
  const pending = createTts({maxPcmBytes: 4}).synthesize('调解内容');
  const socket = FakeWebSocket.instances[0];
  message(socket, {
    code: 0,
    sid: 'size-session',
    data: {audio: Buffer.from([1, 0, 2, 0]).toString('base64'), status: 1}
  });
  message(socket, {
    code: 0,
    data: {audio: Buffer.from([3, 0]).toString('base64'), status: 2}
  });

  await assert.rejects(pending, /PCM.*size limit/i);
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.closeCalls, 0);
});

test('terminates a synthesis that exceeds the bounded response message count', async () => {
  FakeWebSocket.reset();
  const pending = createTts({timeoutMs: 20}).synthesize('调解内容');
  const socket = FakeWebSocket.instances[0];
  message(socket, {code: 0, sid: 'message-limit-session', data: null});
  for (let index = 1; index <= 4_096; index += 1) {
    message(socket, {code: 0, data: null});
  }

  await assert.rejects(pending, /response message limit/i);
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.closeCalls, 0);
});

test('enforces the production PCM ceiling without a caller override', async () => {
  FakeWebSocket.reset();
  const pending = createTts().synthesize('调解内容');
  const socket = FakeWebSocket.instances[0];
  message(socket, {
    code: 0,
    sid: 'default-size-session',
    data: {audio: Buffer.alloc(1_920_002).toString('base64'), status: 2}
  });
  await assert.rejects(pending, /PCM.*size limit/i);
  assert.equal(socket.terminateCalls, 1);
});

test('does not allow a caller to raise the absolute PCM ceiling', async () => {
  FakeWebSocket.reset();
  await assert.rejects(
    () => createTts({maxPcmBytes: 1_920_001, timeoutMs: 5}).synthesize('调解内容'),
    /maxPcmBytes.*at most/i
  );
  assert.equal(FakeWebSocket.instances.length, 0);
});

test('ignores an official null-data frame and accepts an empty final audio marker', async () => {
  FakeWebSocket.reset();
  const controller = new AbortController();
  const pending = createTts().synthesize('调解内容', {signal: controller.signal});
  const socket = FakeWebSocket.instances[0];
  message(socket, {code: 0, sid: 'null-data-session', data: null});
  message(socket, {
    code: 0,
    data: {audio: Buffer.from([1, 0]).toString('base64'), status: 1}
  });
  message(socket, {code: 0, data: {audio: '', status: 2}});

  assert.deepEqual(await pending, Buffer.from([1, 0]));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('times out an incomplete response and terminates its socket', async () => {
  FakeWebSocket.reset();
  const pending = createTts({timeoutMs: 5}).synthesize('调解内容');
  const socket = FakeWebSocket.instances[0];
  await assert.rejects(pending, /timed out/i);
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.closeCalls, 0);
});

test('honors abort before and during synthesis without leaving listeners or sending text', async () => {
  FakeWebSocket.reset();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    () => createTts().synthesize('private mediation text', {signal: alreadyAborted.signal}),
    {name: 'AbortError'}
  );
  assert.equal(FakeWebSocket.instances.length, 0);

  const controller = new AbortController();
  const pending = createTts().synthesize('private mediation text', {signal: controller.signal});
  const socket = FakeWebSocket.instances[0];
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  await nextTurn();
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.terminateCalls, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('sanitizes constructor, connection, send, and premature-close failures', async () => {
  FakeWebSocket.reset();
  const secretText = 'private mediation text';
  class ThrowingWebSocket {
    constructor(url) {
      throw new Error(`cannot connect ${url} test-secret ${secretText}`);
    }
  }
  await assert.rejects(
    () => createTts({WebSocketImpl: ThrowingWebSocket}).synthesize(secretText),
    (error) => {
      assert.match(error.message, /connection failed/i);
      assert.doesNotMatch(error.message, /authorization|test-key|test-secret|private/i);
      return true;
    }
  );

  const connectionPending = createTts().synthesize(secretText);
  const connectionSocket = FakeWebSocket.instances[0];
  connectionSocket.emit('error', new Error(`test-secret ${secretText}`));
  await assert.rejects(connectionPending, (error) => {
    assert.match(error.message, /connection failed/i);
    assert.doesNotMatch(error.message, /test-secret|private/i);
    return true;
  });

  const sendPending = createTts().synthesize(secretText);
  const sendSocket = FakeWebSocket.instances[1];
  sendSocket.onSend = () => { throw new Error(`test-key ${secretText}`); };
  await assert.rejects(sendPending, (error) => {
    assert.match(error.message, /request failed/i);
    assert.doesNotMatch(error.message, /test-key|private/i);
    return true;
  });

  const closePending = createTts().synthesize(secretText);
  const closeSocket = FakeWebSocket.instances[2];
  closeSocket.emit('close', 1006, `test-secret ${secretText}`);
  await assert.rejects(closePending, (error) => {
    assert.match(error.message, /closed before completion/i);
    assert.doesNotMatch(error.message, /test-secret|private|1006/i);
    return true;
  });
});
