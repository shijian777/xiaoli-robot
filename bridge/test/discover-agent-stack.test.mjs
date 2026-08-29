import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverAgentStack, loadDiscoveryConfig} from '../scripts/discover-agent-stack.mjs';

const env = {
  AGENT_STACK_BASE_URL: 'https://agent-stack.test/',
  AGENT_STACK_USER_API_KEY: 'synthetic-uak',
  AGENT_STACK_PROJECT_ID: 'project-test'
};

test('discovery uses only read-only endpoints, scopes only the agents request, and prints safe fields', async () => {
  const calls = [];
  const output = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/api/console/projects')) {
      return new Response(JSON.stringify({projects: [{
        id: 'project-test', name: 'Test Project', status: 'active', apiKey: 'must-not-print'
      }]}), {status: 200, headers: {'content-type': 'application/json'}});
    }
    return new Response(JSON.stringify({agents: [{
      id: 'mediator-test', name: 'Mediator', status: 'active', instructions: 'must-not-print'
    }]}), {status: 200, headers: {'content-type': 'application/json'}});
  };

  await discoverAgentStack({
    config: loadDiscoveryConfig(env),
    fetchImpl,
    write: (line) => output.push(line)
  });

  assert.deepEqual(calls.map(({url, options}) => ({
    url,
    method: options.method,
    authorization: options.headers.authorization,
    projectId: options.headers['x-agent9-project-id']
  })), [
    {
      url: 'https://agent-stack.test/api/console/projects',
      method: 'GET',
      authorization: 'Bearer synthetic-uak',
      projectId: undefined
    },
    {
      url: 'https://agent-stack.test/api/agents',
      method: 'GET',
      authorization: 'Bearer synthetic-uak',
      projectId: 'project-test'
    }
  ]);
  assert.deepEqual(JSON.parse(output.join('\n')), {
    projects: [{id: 'project-test', name: 'Test Project', status: 'active'}],
    agents: [{id: 'mediator-test', name: 'Mediator', status: 'active'}]
  });
  assert.doesNotMatch(output.join('\n'), /synthetic-uak|must-not-print|instructions|apiKey/);
});

test('discovery config rejects missing credentials and invalid base URLs without exposing values', () => {
  assert.throws(() => loadDiscoveryConfig({...env, AGENT_STACK_USER_API_KEY: ''}), /AGENT_STACK_USER_API_KEY/);
  assert.throws(
    () => loadDiscoveryConfig({...env, AGENT_STACK_BASE_URL: 'secret-invalid-url'}),
    (error) => /valid URL/.test(error.message) && !/secret-invalid-url/.test(error.message)
  );
});

test('discovery applies a finite timeout signal to its requests', async () => {
  let receivedSignal;
  const fetchImpl = async (_url, {signal}) => {
    receivedSignal = signal;
    if (!signal) throw new Error('missing timeout signal');
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  };

  await assert.rejects(
    () => discoverAgentStack({config: loadDiscoveryConfig(env), fetchImpl, write() {}, timeoutMs: 5}),
    {name: 'TimeoutError'}
  );
  assert.equal(receivedSignal.aborted, true);
});

test('discovery propagates caller cancellation to its requests', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    controller.abort();
  });

  await assert.rejects(
    () => discoverAgentStack({
      config: loadDiscoveryConfig(env), fetchImpl, write() {}, signal: controller.signal
    }),
    {name: 'AbortError'}
  );
});

test('discovery cancels a failed HTTP response body before rejecting', async () => {
  let cancelCalls = 0;
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    body: {async cancel() { cancelCalls += 1; }}
  });

  await assert.rejects(
    () => discoverAgentStack({config: loadDiscoveryConfig(env), fetchImpl, write() {}}),
    /HTTP 503/
  );
  assert.equal(cancelCalls, 1);
});
