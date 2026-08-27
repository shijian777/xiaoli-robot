import {createServer} from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentStackClient, AsrUnavailableError, ActiveTurnConflictError, TurnFailedError} from '../src/agent-stack/client.mjs';

const credential = 'uak-test-credential';

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function client(baseUrl) {
  return new AgentStackClient({baseUrl, uak: credential, projectId: 'project_test'});
}

function trackedTimers() {
  const active = new Set();
  let scheduled;
  const scheduledPromise = new Promise((resolve) => { scheduled = resolve; });
  let clearCalls = 0;
  return {
    active,
    scheduledPromise,
    get clearCalls() { return clearCalls; },
    setTimeout(callback, milliseconds) {
      const timer = {callback, milliseconds, unref() {}};
      active.add(timer);
      scheduled(timer);
      return timer;
    },
    clearTimeout(timer) {
      clearCalls += 1;
      active.delete(timer);
    }
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(body));
}

function sendTurnEvents(response, events) {
  response.writeHead(200, {'content-type': 'application/x-ndjson'});
  response.end(events.map((event) => JSON.stringify(event)).join('\n'));
}

test('sends authenticated project-scoped discovery, session, text, and WAV multipart requests', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body
    });

    if (request.method === 'GET' && request.url === '/api/console/projects') return sendJson(response, {projects: [{id: 'project_test'}]});
    if (request.method === 'GET' && request.url === '/api/agents') return sendJson(response, {agents: [{id: 'agent-1'}]});
    if (request.method === 'POST' && request.url === '/api/sessions') return sendJson(response, {id: 'session-1'});
    if (request.method === 'POST' && request.url === '/api/sessions/session-1/turns') {
      return sendTurnEvents(response, [
        {type: 'assistant_message', message: 'hello'},
        {type: 'turn_finished', payload: {status: 'succeeded'}}
      ]);
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const api = client(baseUrl);
    assert.deepEqual(await api.listProjects(), [{id: 'project_test'}]);
    assert.deepEqual(await api.listAgents(), [{id: 'agent-1'}]);
    assert.equal(await api.createSession('agent-1'), 'session-1');
    assert.deepEqual(await api.runTextTurn('session-1', 'Say hello'), {
      assistantMessage: 'hello',
      events: [
        {type: 'assistant_message', message: 'hello'},
        {type: 'turn_finished', payload: {status: 'succeeded'}}
      ],
      status: 'succeeded'
    });
    assert.equal((await api.runAudioTurn('session-1', Buffer.from([82, 73, 70, 70]), 'utterance.wav')).assistantMessage, 'hello');
  });

  for (const request of requests) {
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    assert.equal(request.headers['x-agent9-project-id'], 'project_test');
  }
  assert.deepEqual(JSON.parse(requests[2].body.toString('utf8')), {agentId: 'agent-1'});
  assert.deepEqual(JSON.parse(requests[3].body.toString('utf8')), {input: {type: 'text', text: 'Say hello'}});
  assert.match(requests[4].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(requests[4].body.toString('latin1'), /name="file"; filename="utterance\.wav"/);
  assert.match(requests[4].body.toString('latin1'), /Content-Type: audio\/wav/);
});

test('retries a discovery GET once after a retryable response but does not retry a Turn POST', async () => {
  let projectAttempts = 0;
  let turnAttempts = 0;
  await withServer((request, response) => {
    if (request.url === '/api/console/projects') {
      projectAttempts += 1;
      if (projectAttempts === 1) {
        response.writeHead(503, {'retry-after': '0'}).end();
      } else sendJson(response, {projects: []});
      return;
    }
    if (request.url === '/api/sessions/session-1/turns') {
      turnAttempts += 1;
      response.writeHead(503, {'retry-after': '0'}).end();
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const api = client(baseUrl);
    assert.deepEqual(await api.listProjects(), []);
    await assert.rejects(() => api.runTextTurn('session-1', 'do not duplicate'), /503/);
  });
  assert.equal(projectAttempts, 2);
  assert.equal(turnAttempts, 1);
});

test('maps audio 501 and active-turn 409 to non-retryable client errors without exposing the UAK', async () => {
  let attempts = 0;
  await withServer((request, response) => {
    attempts += 1;
    if (request.url === '/api/sessions/session-1/turns') {
      response.writeHead(request.headers['content-type']?.startsWith('multipart/') ? 501 : 409).end();
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const api = client(baseUrl);
    await assert.rejects(() => api.runAudioTurn('session-1', Buffer.from([1]), 'clip.wav'), (error) => {
      assert.ok(error instanceof AsrUnavailableError);
      assert.doesNotMatch(error.message, new RegExp(credential));
      return true;
    });
    await assert.rejects(() => api.runTextTurn('session-1', 'conflict'), (error) => {
      assert.ok(error instanceof ActiveTurnConflictError);
      assert.doesNotMatch(error.message, new RegExp(credential));
      return true;
    });
  });
  assert.equal(attempts, 2);
});

test('rejects a turn without exactly one successful assistant terminal event and preserves sanitized turn errors', async () => {
  await withServer((request, response) => {
    if (request.url === '/api/sessions/session-1/turns') {
      return sendTurnEvents(response, [
        {type: 'turn_error', code: 'MODEL_DOWN', message: `upstream rejected ${credential}`},
        {type: 'turn_finished', payload: {status: 'failed'}}
      ]);
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    await assert.rejects(() => client(baseUrl).runTextTurn('session-1', 'test'), (error) => {
      assert.ok(error instanceof TurnFailedError);
      assert.deepEqual(error.turnError, {code: 'MODEL_DOWN', message: 'upstream rejected [REDACTED]'});
      assert.doesNotMatch(error.message, new RegExp(credential));
      return true;
    });
  });
});

test('aborts an in-flight Agent Stack Turn through the caller signal', async () => {
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  await withServer((request, response) => {
    if (request.url === '/api/sessions/session-1/turns') {
      requestStarted();
      setTimeout(() => sendTurnEvents(response, [
        {type: 'assistant_message', message: 'too late'},
        {type: 'turn_finished', payload: {status: 'succeeded'}}
      ]), 50);
    }
  }, async (baseUrl) => {
    const controller = new AbortController();
    const pending = client(baseUrl).runTextTurn('session-1', 'cancel me', {signal: controller.signal});
    await started;
    controller.abort();
    await assert.rejects(pending, {name: 'AbortError'});
  });
});

test('aborts a long Retry-After delay promptly and leaves no live retry timer', async () => {
  let attempts = 0;
  let firstResponseSent;
  const firstResponse = new Promise((resolve) => { firstResponseSent = resolve; });
  const timers = trackedTimers();

  await withServer((request, response) => {
    if (request.url === '/api/console/projects') {
      attempts += 1;
      response.writeHead(503, {'retry-after': '1'}).end();
      firstResponseSent();
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const controller = new AbortController();
    const api = new AgentStackClient({
      baseUrl,
      uak: credential,
      projectId: 'project_test',
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    const pending = api.listProjects({signal: controller.signal});
    void pending.catch(() => {});
    await firstResponse;

    const retryTimer = await Promise.race([
      timers.scheduledPromise,
      delay(50).then(() => null)
    ]);
    controller.abort();
    const outcome = await Promise.race([
      pending.then(
        () => ({status: 'resolved'}),
        (error) => ({status: 'rejected', name: error.name})
      ),
      delay(50).then(() => ({status: 'pending'}))
    ]);

    assert.equal(retryTimer?.milliseconds, 1000);
    assert.deepEqual(outcome, {status: 'rejected', name: 'AbortError'});
    assert.equal(timers.active.size, 0);
    assert.equal(timers.clearCalls, 1);
    assert.equal(attempts, 1);
  });
});

test('interprets an HTTP-date Retry-After header as a bounded delay', async () => {
  let firstResponseSent;
  const firstResponse = new Promise((resolve) => { firstResponseSent = resolve; });
  const timers = trackedTimers();

  await withServer((request, response) => {
    if (request.url === '/api/console/projects') {
      response.writeHead(503, {'retry-after': new Date(Date.now() + 5_000).toUTCString()}).end();
      firstResponseSent();
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const controller = new AbortController();
    const api = new AgentStackClient({
      baseUrl,
      uak: credential,
      projectId: 'project_test',
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    const pending = api.listProjects({signal: controller.signal});
    void pending.catch(() => {});
    await firstResponse;
    const retryTimer = await timers.scheduledPromise;

    assert.ok(retryTimer.milliseconds > 0);
    assert.ok(retryTimer.milliseconds <= 5_000);
    controller.abort();
    await assert.rejects(pending, {name: 'AbortError'});
    assert.equal(timers.active.size, 0);
  });
});

async function assertZeroRetryAfter(retryAfter) {
  let attempts = 0;
  let firstResponseSent;
  let secondRequest;
  const firstResponse = new Promise((resolve) => { firstResponseSent = resolve; });
  const secondResponse = new Promise((resolve) => { secondRequest = resolve; });
  const timers = trackedTimers();

  await withServer((request, response) => {
    if (request.url === '/api/console/projects') {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(503, {'retry-after': retryAfter}).end();
        firstResponseSent();
      } else {
        sendJson(response, {projects: []});
        secondRequest();
      }
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const controller = new AbortController();
    const api = new AgentStackClient({
      baseUrl,
      uak: credential,
      projectId: 'project_test',
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    const pending = api.listProjects({signal: controller.signal});
    void pending.catch(() => {});
    await firstResponse;
    const retryTimer = await timers.scheduledPromise;

    assert.equal(retryTimer.milliseconds, 0);
    retryTimer.callback();
    await secondResponse;
    assert.equal(attempts, 2);
    assert.deepEqual(await pending, []);
    assert.equal(timers.active.size, 0);
  });
}

test('treats malformed Retry-After as an immediate discovery retry', async () => {
  await assertZeroRetryAfter('not-a-delay');
});

test('treats negative Retry-After as an immediate discovery retry', async () => {
  await assertZeroRetryAfter('-10');
});
