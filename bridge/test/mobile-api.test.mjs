import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';

let mobileModule;
try {
  mobileModule = await import('../src/mobile/mobile-api.mjs');
} catch {
  mobileModule = {};
}

const ADMIN_TOKEN = 'mobile-admin-test-token';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return {promise, resolve};
}

function fixtures(overrides = {}) {
  const calls = {mediations: [], saved: []};
  let voice = {voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50};
  return {
    calls,
    options: {
      adminToken: ADMIN_TOKEN,
      now: () => Date.UTC(2026, 7, 29, 8, 0, 0),
      controlPlane: {
        mobileSnapshot() {
          return {
            devices: [{
              deviceId: 'rorolee-1', online: true, state: 'waiting',
              currentCaseId: 'case-1', case: {
                caseId: 'case-1', canMediate: true,
                speakers: {A: [{state: 'saved', transcript: 'A 的陈述'}], B: [{state: 'saved', transcript: 'B 的陈述'}]}
              }
            }]
          };
        },
        async requestMobileMediation(deviceId) {
          calls.mediations.push(deviceId);
          return {requestId: 'mobile-mediate-1', caseId: 'case-1'};
        }
      },
      ttsService: {
        getVoiceSettings() { return {...voice}; },
        updateVoiceSettings(candidate) { voice = {...candidate}; return {...voice}; }
      },
      voiceSettingsStore: {
        async save(candidate) { calls.saved.push({...candidate}); }
      },
      ...overrides
    }
  };
}

async function withApi(options, run) {
  assert.equal(typeof mobileModule.createMobileApi, 'function', 'createMobileApi must be implemented');
  const api = mobileModule.createMobileApi(options);
  const server = createServer((request, response) => {
    Promise.resolve(api.handle(request, response)).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
        response.end('Not found');
      }
    }).catch(() => {
      if (!response.writableEnded) {
        response.writeHead(500, {'content-type': 'application/json; charset=utf-8'});
        response.end('{"error":"internal_error"}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(port, path, {method = 'GET', token, body, contentType} = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (contentType !== undefined) headers['content-type'] = contentType;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {method, headers, body});
  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text === '' ? null : JSON.parse(text)
  };
}

test('Mobile API requires the independent bearer token and returns no secret detail', async () => {
  const {options} = fixtures();
  await withApi(options, async (port) => {
    for (const token of [undefined, '', 'wrong-token']) {
      const result = await request(port, '/api/mobile/v1/status', {token});
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, {error: 'unauthorized'});
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.doesNotMatch(JSON.stringify(result), /mobile-admin-test-token|wrong-token/);
    }
  });
});

test('GET status returns one sanitized control snapshot and current voice settings', async () => {
  const {options} = fixtures();
  await withApi(options, async (port) => {
    const result = await request(port, '/api/mobile/v1/status', {token: ADMIN_TOKEN});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      version: 1,
      serverTime: '2026-08-29T08:00:00.000Z',
      devices: options.controlPlane.mobileSnapshot().devices,
      voice: {voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50}
    });
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
  });
});

test('mobile status and mediation remain available when the selected TTS has no voice controls', async () => {
  const {options} = fixtures({
    ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
    voiceSettingsStore: undefined
  });
  await withApi(options, async (port) => {
    const status = await request(port, '/api/mobile/v1/status', {token: ADMIN_TOKEN});
    assert.equal(status.status, 200);
    assert.equal(status.body.voice, null);

    const voice = await request(port, '/api/mobile/v1/voice', {token: ADMIN_TOKEN});
    assert.equal(voice.status, 200);
    assert.deepEqual(voice.body, {available: false});

    const update = await request(port, '/api/mobile/v1/voice', {
      method: 'PUT', token: ADMIN_TOKEN, contentType: 'application/json', body: JSON.stringify({
        voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50
      })
    });
    assert.equal(update.status, 409);
    assert.deepEqual(update.body, {error: 'voice_settings_unavailable'});

    const mediate = await request(port, '/api/mobile/v1/devices/rorolee-1/mediate', {
      method: 'POST', token: ADMIN_TOKEN, contentType: 'application/json', body: '{}'
    });
    assert.equal(mediate.status, 202);
  });
});

test('POST mediate decodes one device id and returns the accepted durable request', async () => {
  const {options, calls} = fixtures();
  await withApi(options, async (port) => {
    const result = await request(port, '/api/mobile/v1/devices/rorolee-1/mediate', {
      method: 'POST', token: ADMIN_TOKEN, contentType: 'application/json', body: '{}'
    });
    assert.equal(result.status, 202);
    assert.deepEqual(result.body, {requestId: 'mobile-mediate-1', caseId: 'case-1'});
    assert.deepEqual(calls.mediations, ['rorolee-1']);
  });
});

test('PUT voice accepts only the complete bounded schema and persists before applying it', async () => {
  const {options, calls} = fixtures();
  await withApi(options, async (port) => {
    const settings = {voice: 'x4_yezi', speed: 42, volume: 61, pitch: 48};
    const result = await request(port, '/api/mobile/v1/voice', {
      method: 'PUT', token: ADMIN_TOKEN, contentType: 'application/json', body: JSON.stringify(settings)
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, settings);
    assert.deepEqual(calls.saved, [settings]);

    for (const invalid of [
      {...settings, speed: -1}, {...settings, volume: 101}, {...settings, pitch: 4.5},
      {...settings, voice: '../unsafe'}, {voice: 'x4_yezi', speed: 50, volume: 50}
    ]) {
      const rejected = await request(port, '/api/mobile/v1/voice', {
        method: 'PUT', token: ADMIN_TOKEN, contentType: 'application/json', body: JSON.stringify(invalid)
      });
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.body, {error: 'invalid_voice_settings'});
    }
    assert.equal(calls.saved.length, 1);
  });
});

test('concurrent voice updates serialize persistence and runtime application in request order', async () => {
  const firstSaved = deferred();
  const releaseFirst = deferred();
  const events = [];
  let voice = {voice: 'x4_xiaoyan', speed: 50, volume: 50, pitch: 50};
  const first = {voice: 'x4_first', speed: 40, volume: 51, pitch: 52};
  const second = {voice: 'x4_second', speed: 60, volume: 61, pitch: 62};
  const {options} = fixtures({
    ttsService: {
      getVoiceSettings() { return {...voice}; },
      updateVoiceSettings(candidate) {
        events.push(`apply:${candidate.voice}`);
        voice = {...candidate};
        return {...voice};
      }
    },
    voiceSettingsStore: {
      async save(candidate) {
        events.push(`save:${candidate.voice}`);
        if (candidate.voice === first.voice) {
          firstSaved.resolve();
          await releaseFirst.promise;
        }
      }
    }
  });
  await withApi(options, async (port) => {
    const update = (value) => request(port, '/api/mobile/v1/voice', {
      method: 'PUT', token: ADMIN_TOKEN, contentType: 'application/json', body: JSON.stringify(value)
    });
    const firstRequest = update(first);
    await firstSaved.promise;
    const secondRequest = update(second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const eventsWhileFirstBlocked = [...events];
    releaseFirst.resolve();
    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(eventsWhileFirstBlocked, [`save:${first.voice}`]);
    assert.deepEqual(events, [
      `save:${first.voice}`, `apply:${first.voice}`,
      `save:${second.voice}`, `apply:${second.voice}`
    ]);
    assert.deepEqual(voice, second);
  });
});

test('Mobile API rejects unsupported media types, malformed JSON and bodies above 16 KiB', async () => {
  const {options} = fixtures();
  await withApi(options, async (port) => {
    const unsupported = await request(port, '/api/mobile/v1/voice', {
      method: 'PUT', token: ADMIN_TOKEN, contentType: 'text/plain', body: '{}'
    });
    assert.equal(unsupported.status, 415);
    assert.deepEqual(unsupported.body, {error: 'unsupported_media_type'});

    const malformed = await request(port, '/api/mobile/v1/voice', {
      method: 'PUT', token: ADMIN_TOKEN, contentType: 'application/json', body: '{'
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body, {error: 'invalid_json'});

    const oversized = await request(port, '/api/mobile/v1/voice', {
      method: 'PUT', token: ADMIN_TOKEN, contentType: 'application/json', body: `{"padding":"${'x'.repeat(17 * 1024)}"}`
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(oversized.body, {error: 'request_too_large'});
  });
});

test('Mobile API rejects an oversized chunked body before the client finishes uploading it', async () => {
  const {options} = fixtures();
  await withApi(options, async (port) => {
    const socket = createConnection({host: '127.0.0.1', port});
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const oversizedChunk = 'x'.repeat((16 * 1024) + 1);
      socket.write([
        'PUT /api/mobile/v1/voice HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${ADMIN_TOKEN}`,
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: keep-alive',
        '',
        `${oversizedChunk.length.toString(16)}\r\n${oversizedChunk}\r\n`
      ].join('\r\n'));

      const responseHead = await Promise.race([
        new Promise((resolve, reject) => {
          let received = '';
          socket.on('data', (chunk) => {
            received += chunk.toString('latin1');
            if (received.includes('\r\n\r\n')) resolve(received);
          });
          socket.once('error', reject);
        }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('oversized request was not rejected promptly')), 500))
      ]);
      assert.match(responseHead, /^HTTP\/1\.1 413 /);
      assert.match(responseHead, /\r\nconnection: close\r\n/i);
    } finally {
      socket.destroy();
    }
  });
});

test('Mobile API maps safe control-plane errors without exposing internal messages', async () => {
  for (const [code, status] of [['device_offline', 409], ['mediation_not_ready', 409], ['device_not_found', 404]]) {
    const error = Object.assign(new Error(`private ${code} detail`), {code});
    const {options} = fixtures({
      controlPlane: {
        mobileSnapshot() { return {devices: []}; },
        async requestMobileMediation() { throw error; }
      }
    });
    await withApi(options, async (port) => {
      const result = await request(port, '/api/mobile/v1/devices/device-1/mediate', {
        method: 'POST', token: ADMIN_TOKEN, contentType: 'application/json', body: '{}'
      });
      assert.equal(result.status, status);
      assert.deepEqual(result.body, {error: code});
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

test('Mobile API declines unrelated routes without writing a response', async () => {
  const {options} = fixtures();
  await withApi(options, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/unrelated`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found');
  });
});
