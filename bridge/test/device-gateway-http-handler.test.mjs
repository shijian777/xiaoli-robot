import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createConnection} from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceGateway} from '../src/device-gateway.mjs';

function options(tempDir, httpHandler) {
  return {
    deviceToken: 'device-test-token',
    tempDir,
    stateDir: path.join(tempDir, 'state'),
    asrService: {async transcribe() { return 'unused'; }},
    mediatorService: {async mediate() { throw new Error('unused'); }},
    ttsService: {async synthesize() { throw new Error('unused'); }},
    createMediatorSession: async () => 'unused',
    httpHandler
  };
}

async function withGateway(httpHandler, run) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-http-handler-'));
  const gateway = createDeviceGateway(options(tempDir, httpHandler));
  try {
    await gateway.listen({host: '127.0.0.1', port: 0});
    await run(gateway.address().port);
  } finally {
    await gateway.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  }
}

test('device gateway delegates non-health HTTP requests to an async handler', async () => {
  const seen = [];
  await withGateway(async (request, response) => {
    seen.push(request.url);
    if (request.url !== '/mobile/') return false;
    response.writeHead(200, {'content-type': 'text/plain'});
    response.end('mobile');
    return true;
  }, async (port) => {
    const mobile = await fetch(`http://127.0.0.1:${port}/mobile/`);
    assert.equal(mobile.status, 200);
    assert.equal(await mobile.text(), 'mobile');
    const missing = await fetch(`http://127.0.0.1:${port}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'Not found');
    assert.deepEqual(seen, ['/mobile/', '/missing']);
  });
});

test('device gateway keeps health local and converts handler rejection to generic 500', async () => {
  let calls = 0;
  await withGateway(async () => {
    calls += 1;
    throw new Error('private handler detail');
  }, async (port) => {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {status: 'ok'});
    assert.equal(calls, 0);

    const failed = await fetch(`http://127.0.0.1:${port}/mobile/`);
    assert.equal(failed.status, 500);
    const body = await failed.text();
    assert.deepEqual(JSON.parse(body), {error: 'internal_error'});
    assert.doesNotMatch(body, /private/);
    assert.equal(calls, 1);
  });
});

test('device gateway shutdown force-closes a client stalled in an HTTP request body', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'xiaoli-http-shutdown-'));
  let markHandlerStarted;
  const handlerStarted = new Promise((resolve) => { markHandlerStarted = resolve; });
  const gateway = createDeviceGateway(options(tempDir, async (request, response) => {
    markHandlerStarted();
    for await (const _chunk of request) {
      // Intentionally wait for the declared request body.
    }
    if (!response.writableEnded) response.end('done');
    return true;
  }));
  let socket;
  let shutdownPromise;
  try {
    await gateway.listen({host: '127.0.0.1', port: 0});
    socket = createConnection({host: '127.0.0.1', port: gateway.address().port});
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write([
      'POST /mobile/ HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/octet-stream',
      'Content-Length: 100',
      '',
      'x'
    ].join('\r\n'));
    await handlerStarted;

    shutdownPromise = gateway.shutdown({graceMs: 20, cancelGraceMs: 200, closeGraceMs: 20});
    await Promise.race([
      shutdownPromise,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('shutdown remained blocked by the stalled HTTP client')), 750))
    ]);
    assert.equal(socket.destroyed, true);
  } finally {
    socket?.destroy();
    await shutdownPromise?.catch(() => {});
    await gateway.shutdown().catch(() => {});
    await rm(tempDir, {recursive: true, force: true});
  }
});
