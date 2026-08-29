import {createHmac} from 'node:crypto';
import WebSocket from 'ws';

const DEFAULT_ENDPOINT = 'wss://tts-api.xfyun.cn/v2/tts';
const MAX_TEXT_BYTES = 8_000;
const MAX_SID_BYTES = 256;
export const MAX_XFYUN_TTS_PCM_BYTES = 1_920_000;
const MAX_RESPONSE_FRAME_BYTES = Math.ceil(MAX_XFYUN_TTS_PCM_BYTES / 3) * 4 + 64 * 1024;
const MAX_RESPONSE_MESSAGES = 4_096;

function abortError() {
  return new DOMException('Xfyun TTS synthesis aborted', 'AbortError');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isSafeSid(value) {
  return typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') <= MAX_SID_BYTES &&
    /^[\x21-\x7e]+$/.test(value);
}

function isSuccessCode(value) {
  return value === 0;
}

function validatedVoiceSettings({voice, speed, volume, pitch}) {
  if (!isNonEmptyString(voice) || !/^[A-Za-z0-9_-]{1,64}$/.test(voice)) {
    throw new TypeError('voice must be a valid voice identifier');
  }
  for (const [name, value] of Object.entries({speed, volume, pitch})) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      throw new TypeError(`${name} must be an integer from 0 to 100`);
    }
  }
  return {voice, speed, volume, pitch};
}

function isSafeUpstreamCode(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 99_999_999;
}

function upstreamError(payload) {
  const error = new Error('Xfyun TTS service rejected the request');
  error.upstreamCode = isSafeUpstreamCode(payload?.code) ? String(payload.code) : 'UNKNOWN';
  return error;
}

function decodeBase64Audio(audio) {
  if (typeof audio !== 'string' || audio.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio)) {
    throw new Error('invalid base64 audio');
  }
  return Buffer.from(audio, 'base64');
}

function attach(socket, event, listener) {
  if (typeof socket.on === 'function') socket.on(event, listener);
  else socket.addEventListener(event, listener);
}

export class XfyunTts {
  #voiceSettings;

  constructor({
    appId,
    apiKey,
    apiSecret,
    voice = 'x4_xiaoyan',
    speed = 50,
    volume = 50,
    pitch = 50,
    endpoint = DEFAULT_ENDPOINT,
    WebSocketImpl = WebSocket,
    now = Date.now,
    timeoutMs = 90_000,
    maxPcmBytes = MAX_XFYUN_TTS_PCM_BYTES
  } = {}) {
    this.appId = appId;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.#voiceSettings = validatedVoiceSettings({voice, speed, volume, pitch});
    this.endpoint = endpoint;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.maxPcmBytes = maxPcmBytes;
  }

  getVoiceSettings() {
    return {...this.#voiceSettings};
  }

  updateVoiceSettings(settings) {
    const next = validatedVoiceSettings({...this.#voiceSettings, ...settings});
    this.#voiceSettings = next;
    return this.getVoiceSettings();
  }

  async synthesize(text, {signal} = {}) {
    if (!isNonEmptyString(this.appId) || !isNonEmptyString(this.apiKey) || !isNonEmptyString(this.apiSecret)) {
      throw new Error('Xfyun TTS credentials are required');
    }
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (text.trim() === '') throw new TypeError('text must be a non-empty string');
    if (Buffer.byteLength(text, 'utf8') >= MAX_TEXT_BYTES) {
      throw new TypeError('text must be less than 8000 UTF-8 bytes');
    }
    if (typeof this.WebSocketImpl !== 'function') throw new TypeError('WebSocketImpl must be a constructor');
    if (typeof this.now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a positive integer');
    }
    if (!Number.isSafeInteger(this.maxPcmBytes) || this.maxPcmBytes <= 0) {
      throw new TypeError('maxPcmBytes must be a positive integer');
    }
    if (this.maxPcmBytes > MAX_XFYUN_TTS_PCM_BYTES) {
      throw new TypeError(`maxPcmBytes must be at most ${MAX_XFYUN_TTS_PCM_BYTES}`);
    }
    if (signal?.aborted) throw abortError();
    const voiceSettings = this.getVoiceSettings();

    let endpoint;
    try {
      endpoint = new URL(this.endpoint);
    } catch {
      throw new TypeError('Xfyun TTS endpoint is invalid');
    }
    if (endpoint.protocol !== 'wss:' && endpoint.protocol !== 'ws:') {
      throw new TypeError('Xfyun TTS endpoint must use WebSocket');
    }
    const dateValue = new Date(this.now());
    if (Number.isNaN(dateValue.getTime())) throw new Error('Xfyun TTS clock is invalid');
    const date = dateValue.toUTCString();
    const signatureOrigin = `host: ${endpoint.host}\ndate: ${date}\nGET ${endpoint.pathname} HTTP/1.1`;
    const signature = createHmac('sha256', this.apiSecret)
      .update(signatureOrigin)
      .digest('base64');
    const authorizationOrigin = `api_key="${this.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    endpoint.searchParams.set('host', endpoint.host);
    endpoint.searchParams.set('date', date);
    endpoint.searchParams.set('authorization', Buffer.from(authorizationOrigin, 'utf8').toString('base64'));

    return new Promise((resolve, reject) => {
      let socket;
      let timer;
      const pcmBuffer = Buffer.allocUnsafe(this.maxPcmBytes);
      let totalBytes = 0;
      let responseMessages = 0;
      let settled = false;
      let sessionSid;

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const releaseSocket = (force) => {
        if (!socket) return;
        if (force && typeof socket.terminate === 'function') {
          try {
            socket.terminate();
            return;
          } catch {}
        }
        try { socket.close(); } catch {}
      };
      const settle = (error, pcm, {socketClosed = false} = {}) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!socketClosed) releaseSocket(Boolean(error));
        if (error) reject(error);
        else resolve(pcm);
      };
      const invalid = (detail) => settle(new Error(`Xfyun TTS returned an invalid ${detail}`));
      const onAbort = () => settle(abortError());

      try {
        socket = new this.WebSocketImpl(endpoint.toString(), {maxPayload: MAX_RESPONSE_FRAME_BYTES});
      } catch {
        settle(new Error('Xfyun TTS connection failed'));
        return;
      }

      attach(socket, 'open', () => {
        if (settled) return;
        try {
          socket.send(JSON.stringify({
            common: {app_id: this.appId},
            business: {
              aue: 'raw',
              auf: 'audio/L16;rate=16000',
              vcn: voiceSettings.voice,
              speed: voiceSettings.speed,
              volume: voiceSettings.volume,
              pitch: voiceSettings.pitch,
              tte: 'UTF8'
            },
            data: {
              status: 2,
              text: Buffer.from(text, 'utf8').toString('base64')
            }
          }));
        } catch {
          settle(new Error('Xfyun TTS request failed'));
        }
      });
      attach(socket, 'message', (frame, isBinary = false) => {
        if (settled) return;
        responseMessages += 1;
        if (responseMessages > MAX_RESPONSE_MESSAGES) {
          settle(new Error('Xfyun TTS response message limit exceeded'));
          return;
        }
        if (isBinary) {
          invalid('response');
          return;
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.isBuffer(frame) ? frame.toString('utf8') : String(frame));
        } catch {
          invalid('response');
          return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'code')) {
          invalid('response');
          return;
        }
        if (!isSuccessCode(payload.code)) {
          if (isSafeUpstreamCode(payload.code)) settle(upstreamError(payload));
          else invalid('response code');
          return;
        }

        if (sessionSid === undefined) {
          if (!isSafeSid(payload.sid)) {
            invalid('session sid');
            return;
          }
          sessionSid = payload.sid;
        } else if (Object.hasOwn(payload, 'sid') && payload.sid !== sessionSid) {
          invalid('session sid');
          return;
        }

        if (payload.data === null) return;
        if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
          invalid('response data');
          return;
        }
        const {audio, status} = payload.data;
        if (status !== 1 && status !== 2) {
          invalid('stream status');
          return;
        }
        if (typeof audio !== 'string') {
          invalid('audio payload');
          return;
        }
        if (audio.length > Math.ceil(this.maxPcmBytes / 3) * 4 + 4) {
          settle(new Error('Xfyun TTS PCM output exceeded the size limit'));
          return;
        }
        let chunk;
        try {
          chunk = decodeBase64Audio(audio);
        } catch {
          invalid('audio payload');
          return;
        }
        if (totalBytes + chunk.length > this.maxPcmBytes) {
          settle(new Error('Xfyun TTS PCM output exceeded the size limit'));
          return;
        }
        if (chunk.length > 0) {
          chunk.copy(pcmBuffer, totalBytes);
          totalBytes += chunk.length;
        }
        if (status === 2) {
          if (totalBytes === 0) {
            settle(new Error('Xfyun TTS returned empty PCM output'));
            return;
          }
          if (totalBytes % 2 !== 0) {
            settle(new Error('Xfyun TTS PCM output must contain an even number of bytes'));
            return;
          }
          settle(null, Buffer.from(pcmBuffer.subarray(0, totalBytes)));
        }
      });
      attach(socket, 'error', () => settle(new Error('Xfyun TTS connection failed')));
      attach(socket, 'close', () => {
        if (!settled) settle(new Error('Xfyun TTS connection closed before completion'), undefined, {socketClosed: true});
      });

      timer = setTimeout(() => settle(new Error('Xfyun TTS synthesis timed out')), this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) onAbort();
    });
  }
}
