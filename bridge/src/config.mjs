const REQUIRED_ENV = [
  'AGENT_STACK_BASE_URL',
  'AGENT_STACK_USER_API_KEY',
  'AGENT_STACK_PROJECT_ID',
  'ASR_AGENT_ID',
  'MEDIATOR_AGENT_ID',
  'DEVICE_SHARED_TOKEN'
];

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8788;
const DEFAULT_PYTHON_BIN = 'python';
const DEFAULT_WHISPER_MODEL = 'small';

function requiredValue(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parsePort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BRIDGE_PORT must be an integer from 1 to 65535`);
  }
  return port;
}

/**
 * Load and validate all configuration required by the local bridge.
 *
 * The caller supplies process.env (or an equivalent object) so this module
 * never reads secrets from source files or embeds them in the application.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{baseUrl:string,uak:string,projectId:string,asrAgentId:string,mediatorAgentId:string,deviceToken:string,host:string,port:number,sampleRate:number,bits:number,channels:number,pythonBin:string,whisperModel:string,tempDir:string}}
 */
export function loadConfig(env = process.env) {
  for (const name of REQUIRED_ENV) {
    requiredValue(env, name);
  }

  const baseUrl = requiredValue(env, 'AGENT_STACK_BASE_URL').replace(/\/+$/, '');
  try {
    // Constructing URL is the validation boundary; retain the normalized
    // string supplied by the caller (apart from its trailing slash).
    new URL(baseUrl);
  } catch {
    throw new Error('AGENT_STACK_BASE_URL must be a valid URL');
  }

  const host = typeof env.BRIDGE_HOST === 'string' && env.BRIDGE_HOST.trim()
    ? env.BRIDGE_HOST.trim()
    : DEFAULT_HOST;
  const port = parsePort(env.BRIDGE_PORT ?? String(DEFAULT_PORT));
  const pythonBin = typeof env.PYTHON_BIN === 'string' && env.PYTHON_BIN.trim()
    ? env.PYTHON_BIN.trim()
    : DEFAULT_PYTHON_BIN;
  const whisperModel = typeof env.WHISPER_MODEL === 'string' && env.WHISPER_MODEL.trim()
    ? env.WHISPER_MODEL.trim()
    : DEFAULT_WHISPER_MODEL;
  const tempDir = typeof env.BRIDGE_TEMP_DIR === 'string' && env.BRIDGE_TEMP_DIR.trim()
    ? env.BRIDGE_TEMP_DIR.trim()
    : 'tmp';

  return {
    baseUrl,
    uak: requiredValue(env, 'AGENT_STACK_USER_API_KEY'),
    projectId: requiredValue(env, 'AGENT_STACK_PROJECT_ID'),
    asrAgentId: requiredValue(env, 'ASR_AGENT_ID'),
    mediatorAgentId: requiredValue(env, 'MEDIATOR_AGENT_ID'),
    deviceToken: requiredValue(env, 'DEVICE_SHARED_TOKEN'),
    host,
    port,
    sampleRate: 16000,
    bits: 16,
    channels: 1,
    pythonBin,
    whisperModel,
    tempDir
  };
}
