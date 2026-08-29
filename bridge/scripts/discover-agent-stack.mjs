import path from 'node:path';
import {pathToFileURL} from 'node:url';

function requiredValue(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function loadDiscoveryConfig(env = process.env) {
  const baseUrl = requiredValue(env, 'AGENT_STACK_BASE_URL').replace(/\/+$/, '');
  try {
    new URL(baseUrl);
  } catch {
    throw new Error('AGENT_STACK_BASE_URL must be a valid URL');
  }
  return {
    baseUrl,
    uak: requiredValue(env, 'AGENT_STACK_USER_API_KEY'),
    projectId: requiredValue(env, 'AGENT_STACK_PROJECT_ID')
  };
}

export async function discoverAgentStack({
  config = loadDiscoveryConfig(process.env),
  fetchImpl = fetch,
  write = (line) => console.log(line),
  signal,
  timeoutMs = 10_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof write !== 'function') throw new TypeError('write must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer');
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const projects = await getCollection(fetchImpl, `${config.baseUrl}/api/console/projects`, 'projects', {
    authorization: `Bearer ${config.uak}`
  }, requestSignal);
  const agents = await getCollection(fetchImpl, `${config.baseUrl}/api/agents`, 'agents', {
    authorization: `Bearer ${config.uak}`,
    'x-agent9-project-id': config.projectId
  }, requestSignal);
  const safeResult = {
    projects: projects.map(safeIdentity),
    agents: agents.map(safeIdentity)
  };
  write(JSON.stringify(safeResult, null, 2));
  return safeResult;
}

async function getCollection(fetchImpl, url, field, headers, signal) {
  const response = await fetchImpl(url, {method: 'GET', headers, redirect: 'error', signal});
  if (!response?.ok) {
    try { await response?.body?.cancel?.(); } catch {}
    throw new Error(`Agent Stack discovery request failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Agent Stack discovery returned invalid JSON');
  }
  const collection = body?.[field] ?? body;
  if (!Array.isArray(collection)) {
    throw new Error(`Agent Stack discovery response did not contain a ${field} array`);
  }
  return collection;
}

function safeIdentity(value) {
  const safe = {};
  for (const field of ['id', 'name', 'status']) {
    if (typeof value?.[field] === 'string') safe[field] = value[field];
  }
  return safe;
}

async function main() {
  await discoverAgentStack();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error?.message ?? 'Agent Stack discovery failed');
    process.exitCode = 1;
  });
}
