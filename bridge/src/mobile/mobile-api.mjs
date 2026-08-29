import {createHash, timingSafeEqual} from 'node:crypto';
import {isProtocolIdentifier} from '../protocol/limits.mjs';

const API_PREFIX = '/api/mobile/v1/';
const MAX_JSON_BYTES = 16 * 1024;
const VOICE_KEYS = ['pitch', 'speed', 'voice', 'volume'];
const SAFE_CONTROL_ERRORS = new Map([
  ['device_not_found', 404],
  ['device_offline', 409],
  ['mediation_not_ready', 409]
]);

export function createMobileApi(options = {}) {
  return new MobileApi(options);
}

class MobileApi {
  #tokenDigest;
  #controlPlane;
  #tts;
  #voiceStore;
  #voiceConfigurable;
  #now;
  #voiceMutationTail = Promise.resolve();

  constructor({adminToken, controlPlane, ttsService, voiceSettingsStore, now = Date.now} = {}) {
    if (typeof adminToken !== 'string' || adminToken.trim() === '') {
      throw new TypeError('Mobile API adminToken must be a non-empty string');
    }
    if (!controlPlane || typeof controlPlane.mobileSnapshot !== 'function' ||
        typeof controlPlane.requestMobileMediation !== 'function') {
      throw new TypeError('Mobile API requires a controlPlane');
    }
    if (!ttsService || typeof ttsService !== 'object') {
      throw new TypeError('Mobile API requires a TTS service');
    }
    const canReadVoice = typeof ttsService.getVoiceSettings === 'function';
    const canUpdateVoice = typeof ttsService.updateVoiceSettings === 'function';
    if (canReadVoice !== canUpdateVoice) {
      throw new TypeError('Mobile API TTS voice controls must provide both read and update methods');
    }
    if (canReadVoice && (!voiceSettingsStore || typeof voiceSettingsStore.save !== 'function')) {
      throw new TypeError('Mobile API requires a voiceSettingsStore');
    }
    if (typeof now !== 'function') throw new TypeError('Mobile API now must be a function');
    this.#tokenDigest = digest(adminToken);
    this.#controlPlane = controlPlane;
    this.#tts = ttsService;
    this.#voiceStore = voiceSettingsStore;
    this.#voiceConfigurable = canReadVoice;
    this.#now = now;
  }

  async handle(request, response) {
    const pathname = parsePathname(request.url);
    if (!pathname.startsWith(API_PREFIX)) return false;
    if (!authorized(request.headers.authorization, this.#tokenDigest)) {
      sendJson(response, 401, {error: 'unauthorized'}, {'www-authenticate': 'Bearer'});
      return true;
    }

    if (pathname === '/api/mobile/v1/status' && request.method === 'GET') {
      const snapshot = this.#controlPlane.mobileSnapshot();
      sendJson(response, 200, {
        version: 1,
        serverTime: new Date(this.#now()).toISOString(),
        devices: Array.isArray(snapshot?.devices) ? snapshot.devices : [],
        voice: this.#voiceConfigurable ? this.#tts.getVoiceSettings() : null
      });
      return true;
    }

    if (pathname === '/api/mobile/v1/voice' && request.method === 'GET') {
      sendJson(response, 200, this.#voiceConfigurable
        ? this.#tts.getVoiceSettings()
        : {available: false});
      return true;
    }

    if (pathname === '/api/mobile/v1/voice' && request.method === 'PUT') {
      if (!this.#voiceConfigurable) {
        request.resume();
        sendJson(response, 409, {error: 'voice_settings_unavailable'});
        return true;
      }
      const parsed = await readJsonRequest(request);
      if (!parsed.ok) {
        sendRequestError(request, response, parsed);
        return true;
      }
      const settings = normalizeVoiceSettings(parsed.value);
      if (!settings) {
        sendJson(response, 400, {error: 'invalid_voice_settings'});
        return true;
      }
      try {
        const update = this.#voiceMutationTail
          .catch(() => {})
          .then(async () => {
            await this.#voiceStore.save(settings);
            return this.#tts.updateVoiceSettings(settings);
          });
        this.#voiceMutationTail = update.catch(() => {});
        const applied = await update;
        sendJson(response, 200, applied ?? settings);
      } catch {
        sendJson(response, 500, {error: 'voice_settings_failed'});
      }
      return true;
    }

    const mediation = pathname.match(/^\/api\/mobile\/v1\/devices\/([^/]+)\/mediate$/);
    if (mediation && request.method === 'POST') {
      const parsed = await readJsonRequest(request);
      if (!parsed.ok) {
        sendRequestError(request, response, parsed);
        return true;
      }
      if (!isPlainObject(parsed.value) || Object.keys(parsed.value).length !== 0) {
        sendJson(response, 400, {error: 'invalid_request'});
        return true;
      }
      let deviceId;
      try {
        deviceId = decodeURIComponent(mediation[1]);
      } catch {
        sendJson(response, 400, {error: 'invalid_device_id'});
        return true;
      }
      if (!isProtocolIdentifier(deviceId)) {
        sendJson(response, 400, {error: 'invalid_device_id'});
        return true;
      }
      try {
        const accepted = await this.#controlPlane.requestMobileMediation(deviceId);
        sendJson(response, 202, {
          requestId: accepted.requestId,
          caseId: accepted.caseId
        });
      } catch (error) {
        const status = SAFE_CONTROL_ERRORS.get(error?.code);
        sendJson(response, status ?? 500, {error: status ? error.code : 'mediation_request_failed'});
      }
      return true;
    }

    const knownPath = pathname === '/api/mobile/v1/status' ||
      pathname === '/api/mobile/v1/voice' || mediation;
    if (knownPath) {
      sendJson(response, 405, {error: 'method_not_allowed'}, {allow: allowedMethods(pathname, Boolean(mediation))});
    } else {
      sendJson(response, 404, {error: 'not_found'});
    }
    return true;
  }
}

function parsePathname(rawUrl) {
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function authorized(header, expectedDigest) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const candidate = header.slice('Bearer '.length);
  if (candidate === '' || candidate !== candidate.trim()) return false;
  return timingSafeEqual(digest(candidate), expectedDigest);
}

async function readJsonRequest(request) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' ||
      contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    request.resume();
    return {ok: false, status: 415, error: 'unsupported_media_type'};
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    request.resume();
    return {ok: false, status: 413, error: 'request_too_large', closeConnection: true};
  }
  const collected = await collectBoundedBody(request);
  if (!collected.ok) return collected;
  try {
    return {ok: true, value: JSON.parse(Buffer.concat(collected.chunks, collected.bytes).toString('utf8'))};
  } catch {
    return {ok: false, status: 400, error: 'invalid_json'};
  }
}

function collectBoundedBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) {
        settle({ok: false, status: 413, error: 'request_too_large', closeConnection: true});
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle({ok: true, chunks, bytes});
    const onAborted = () => fail(Object.assign(new Error('request aborted'), {code: 'REQUEST_ABORTED'}));
    const onError = (error) => fail(error);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

function normalizeVoiceSettings(value) {
  if (!isPlainObject(value) ||
      Object.keys(value).sort().join('\0') !== VOICE_KEYS.join('\0') ||
      typeof value.voice !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.voice)) {
    return null;
  }
  for (const key of ['speed', 'volume', 'pitch']) {
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100) return null;
  }
  return {
    voice: value.voice,
    speed: value.speed,
    volume: value.volume,
    pitch: value.pitch
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function allowedMethods(pathname, mediation) {
  if (mediation) return 'POST';
  return pathname.endsWith('/status') ? 'GET' : 'GET, PUT';
}

function sendRequestError(request, response, parsed) {
  if (parsed.closeConnection) {
    response.shouldKeepAlive = false;
    sendJson(response, parsed.status, {error: parsed.error}, {'connection': 'close'});
    request.resume();
    return;
  }
  sendJson(response, parsed.status, {error: parsed.error});
}

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders
  });
  response.end(payload);
}
