const REQUIRED_ENV = [
  'AGENT_STACK_BASE_URL',
  'AGENT_STACK_USER_API_KEY',
  'AGENT_STACK_PROJECT_ID',
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
  if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort)) {
    throw new Error(`BRIDGE_PORT must be an integer from 1 to 65535`);
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BRIDGE_PORT must be an integer from 1 to 65535`);
  }
  return port;
}

function parseMdnsEnabled(rawValue) {
  if (rawValue === undefined) return true;
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  throw new Error('BRIDGE_MDNS_ENABLED must be either true or false');
}

function optionalMobileAdminToken(rawValue) {
  if (rawValue === undefined || rawValue === '') return null;
  if (typeof rawValue !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(rawValue)) {
    throw new Error('MOBILE_ADMIN_TOKEN must be 32 to 256 printable ASCII characters without whitespace');
  }
  return rawValue;
}

function optionalXfyunRtasr(env) {
  const appId = typeof env?.XFYUN_RTASR_APP_ID === 'string'
    ? env.XFYUN_RTASR_APP_ID.trim()
    : '';
  const apiKey = typeof env?.XFYUN_RTASR_API_KEY === 'string'
    ? env.XFYUN_RTASR_API_KEY.trim()
    : '';
  if ((appId === '') !== (apiKey === '')) {
    throw new Error('XFYUN_RTASR_APP_ID and XFYUN_RTASR_API_KEY must be configured together');
  }
  return appId === '' ? null : {appId, apiKey};
}

function parseTtsProvider(rawValue) {
  const provider = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!['', 'windows', 'espeak-ng', 'xfyun'].includes(provider)) {
    throw new Error('TTS_PROVIDER must be windows, espeak-ng, or xfyun');
  }
  return provider;
}

function parseXfyunTtsControl(env, name) {
  const rawValue = env?.[name];
  if (rawValue === undefined || (typeof rawValue === 'string' && rawValue.trim() === '')) {
    return 50;
  }
  if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue.trim())) {
    throw new Error(`${name} must be an integer from 0 to 100`);
  }
  const value = Number(rawValue.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be an integer from 0 to 100`);
  }
  return value;
}

function optionalXfyunTts(env) {
  const appId = typeof env?.XFYUN_TTS_APP_ID === 'string'
    ? env.XFYUN_TTS_APP_ID.trim()
    : '';
  const apiKey = typeof env?.XFYUN_TTS_API_KEY === 'string'
    ? env.XFYUN_TTS_API_KEY.trim()
    : '';
  const apiSecret = typeof env?.XFYUN_TTS_API_SECRET === 'string'
    ? env.XFYUN_TTS_API_SECRET.trim()
    : '';
  const configured = [appId, apiKey, apiSecret].filter(Boolean).length;
  if (configured !== 0 && configured !== 3) {
    throw new Error(
      'XFYUN_TTS_APP_ID, XFYUN_TTS_API_KEY, and XFYUN_TTS_API_SECRET must be configured together');
  }
  if (configured === 0) return null;
  const voice = typeof env?.XFYUN_TTS_VOICE === 'string' &&
    env.XFYUN_TTS_VOICE.trim() !== ''
    ? env.XFYUN_TTS_VOICE.trim()
    : 'x4_xiaoyan';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(voice)) {
    throw new Error('XFYUN_TTS_VOICE must be a valid voice identifier');
  }
  const speed = parseXfyunTtsControl(env, 'XFYUN_TTS_SPEED');
  const volume = parseXfyunTtsControl(env, 'XFYUN_TTS_VOLUME');
  const pitch = parseXfyunTtsControl(env, 'XFYUN_TTS_PITCH');
  return {appId, apiKey, apiSecret, voice, speed, volume, pitch};
}

/**
 * Load and validate all configuration required by the local bridge.
 *
 * The caller supplies process.env (or an equivalent object) so this module
 * never reads secrets from source files or embeds them in the application.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{baseUrl:string,uak:string,projectId:string,asrAgentId:string|null,mediatorAgentId:string,deviceToken:string,mobileAdminToken:string|null,host:string,port:number,sampleRate:number,bits:number,channels:number,pythonBin:string,whisperModel:string,tempDir:string,stateDir:string,xfyunRtasr:{appId:string,apiKey:string}|null,ttsProvider:string,xfyunTts:{appId:string,apiKey:string,apiSecret:string,voice:string,speed:number,volume:number,pitch:number}|null}}
 */
export function loadConfig(env = process.env) {
  for (const name of REQUIRED_ENV) {
    requiredValue(env, name);
  }
  const xfyunRtasr = optionalXfyunRtasr(env);
  const asrAgentId = xfyunRtasr ? null : requiredValue(env, 'ASR_AGENT_ID');
  const ttsProvider = parseTtsProvider(env.TTS_PROVIDER);
  const xfyunTts = optionalXfyunTts(env);
  if (ttsProvider === 'xfyun' && !xfyunTts) {
    throw new Error('Xfyun TTS provider requires complete Xfyun TTS credentials');
  }

  const baseUrl = requiredValue(env, 'AGENT_STACK_BASE_URL').replace(/\/+$/, '');
  let parsedBaseUrl;
  try {
    // Constructing URL is the validation boundary; retain the normalized
    // string supplied by the caller (apart from its trailing slash).
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error('AGENT_STACK_BASE_URL must be a valid URL');
  }
  const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);
  const isLoopbackHttp = parsedBaseUrl.protocol === 'http:'
    && loopbackHosts.has(parsedBaseUrl.hostname.toLowerCase());
  if (parsedBaseUrl.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error('AGENT_STACK_BASE_URL must use HTTPS except on an explicit loopback host');
  }

  const host = typeof env.BRIDGE_HOST === 'string' && env.BRIDGE_HOST.trim()
    ? env.BRIDGE_HOST.trim()
    : DEFAULT_HOST;
  const port = parsePort(env.BRIDGE_PORT ?? String(DEFAULT_PORT));
  const mdnsEnabled = parseMdnsEnabled(env.BRIDGE_MDNS_ENABLED);
  const pythonBin = typeof env.PYTHON_BIN === 'string' && env.PYTHON_BIN.trim()
    ? env.PYTHON_BIN.trim()
    : DEFAULT_PYTHON_BIN;
  const whisperModel = typeof env.WHISPER_MODEL === 'string' && env.WHISPER_MODEL.trim()
    ? env.WHISPER_MODEL.trim()
    : DEFAULT_WHISPER_MODEL;
  const tempDir = typeof env.BRIDGE_TEMP_DIR === 'string' && env.BRIDGE_TEMP_DIR.trim()
    ? env.BRIDGE_TEMP_DIR.trim()
    : 'tmp';
  const stateDir = typeof env.BRIDGE_STATE_DIR === 'string' && env.BRIDGE_STATE_DIR.trim()
    ? env.BRIDGE_STATE_DIR.trim()
    : 'state';

  return {
    baseUrl,
    uak: requiredValue(env, 'AGENT_STACK_USER_API_KEY'),
    projectId: requiredValue(env, 'AGENT_STACK_PROJECT_ID'),
    asrAgentId,
    mediatorAgentId: requiredValue(env, 'MEDIATOR_AGENT_ID'),
    deviceToken: requiredValue(env, 'DEVICE_SHARED_TOKEN'),
    mobileAdminToken: optionalMobileAdminToken(env.MOBILE_ADMIN_TOKEN),
    host,
    port,
    mdnsEnabled,
    sampleRate: 16000,
    bits: 16,
    channels: 1,
    pythonBin,
    whisperModel,
    tempDir,
    stateDir,
    xfyunRtasr,
    ttsProvider,
    xfyunTts
  };
}
