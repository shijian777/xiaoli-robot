import {createHash, createHmac} from 'node:crypto';
import WebSocket from 'ws';

const FRAME_BYTES = 1280;

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function upstreamError(message, payload) {
  const candidate = String(payload?.code ?? '');
  const error = new Error(message);
  error.upstreamCode = /^\d{1,8}$/.test(candidate) ? candidate : 'UNKNOWN';
  return error;
}

function defaultSleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function finalText(segments) {
  return [...segments.values()]
    .sort((left, right) => {
      if (left.hasValidId && right.hasValidId && left.id !== right.id) return left.id - right.id;
      return left.order - right.order;
    })
    .map(({text}) => text)
    .join('');
}

function parseFinalSegment(data, order) {
  const decoded = typeof data === 'string' ? JSON.parse(data) : data;
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('invalid result payload');
  }
  const type = decoded?.cn?.st?.type;
  if (type !== '0' && type !== 0) return null;
  const words = decoded.cn.st.rt ?? [];
  const text = words.flatMap((rt) => rt.ws ?? [])
    .map((ws) => ws?.cw?.[0]?.w)
    .filter((word) => typeof word === 'string')
    .join('');
  const id = Number(decoded.seg_id);
  const hasValidId = Number.isSafeInteger(id) && id >= 0;
  return {id, hasValidId, key: hasValidId ? `segment:${id}` : `arrival:${order}`, order, text};
}

function attach(socket, event, listener) {
  if (typeof socket.on === 'function') socket.on(event, listener);
  else socket.addEventListener(event, listener);
}

export class XfyunRtasrClient {
  constructor({
    appId,
    apiKey,
    endpoint = 'wss://rtasr.xfyun.cn/v1/ws',
    WebSocketImpl = WebSocket,
    now = Date.now,
    sleep = defaultSleep,
    handshakeTimeoutMs = 10_000,
    resultTimeoutMs = 30_000
  }) {
    this.appId = appId;
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.sleep = sleep;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.resultTimeoutMs = resultTimeoutMs;
  }

  async transcribe(pcm, {signal} = {}) {
    if (!Buffer.isBuffer(pcm)) throw new TypeError('PCM input must be a Buffer');
    if (pcm.length === 0 || pcm.length % 2 !== 0) throw new TypeError('PCM input must contain a non-empty even number of bytes');
    if (signal?.aborted) throw abortError();
    if (typeof this.appId !== 'string' || !this.appId || typeof this.apiKey !== 'string' || !this.apiKey) {
      throw new Error('Xfyun RTASR credentials are required');
    }

    const ts = String(Math.floor(this.now() / 1000));
    const digest = createHash('md5').update(`${this.appId}${ts}`).digest('hex');
    const signa = createHmac('sha1', this.apiKey).update(digest).digest('base64');
    const url = new URL(this.endpoint);
    url.searchParams.set('appid', this.appId);
    url.searchParams.set('ts', ts);
    url.searchParams.set('signa', signa);

    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;
      let handshakeTimer;
      let resultTimer;
      let started = false;
      let endSent = false;
      let segmentOrder = 0;
      const segments = new Map();

      const cleanup = () => {
        clearTimeout(handshakeTimer);
        clearTimeout(resultTimer);
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
      const settle = (error, text, {socketClosed = false} = {}) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!socketClosed) releaseSocket(Boolean(error));
        if (error) reject(error);
        else resolve(text);
      };
      const fail = (message) => settle(new Error(message));
      const rejectService = (message, payload) => settle(upstreamError(message, payload));
      const finishFromResults = (socketClosed = false) => {
        const text = finalText(segments);
        if (!text) settle(new Error('Xfyun RTASR returned an empty final result'), undefined, {socketClosed});
        else settle(null, text, {socketClosed});
      };
      const onAbort = () => settle(abortError());

      const sendAudio = async () => {
        try {
          for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
            if (settled) return;
            if (signal?.aborted) throw abortError();
            socket.send(Buffer.from(pcm.subarray(offset, offset + FRAME_BYTES)));
            await this.sleep(40, signal);
          }
          if (settled) return;
          if (signal?.aborted) throw abortError();
          endSent = true;
          socket.send(Buffer.from('{"end": true}', 'utf8'));
          if (settled) return;
          resultTimer = setTimeout(() => fail('Xfyun RTASR result timed out'), this.resultTimeoutMs);
        } catch (error) {
          settle(error?.name === 'AbortError' ? error : new Error('Xfyun RTASR audio transport failed'));
        }
      };

      try {
        socket = new this.WebSocketImpl(url.toString());
      } catch {
        fail('Xfyun RTASR connection failed');
        return;
      }

      attach(socket, 'message', (frame) => {
        if (settled) return;
        let payload;
        try {
          payload = JSON.parse(Buffer.isBuffer(frame) ? frame.toString('utf8') : String(frame));
        } catch {
          fail('Xfyun RTASR returned an invalid response');
          return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          fail('Xfyun RTASR returned an invalid response');
          return;
        }
        if (payload.action === 'error') {
          rejectService('Xfyun RTASR service rejected the request', payload);
          return;
        }
        if (Object.hasOwn(payload, 'code') && payload.code !== 0 && payload.code !== '0') {
          rejectService(payload.action === 'started' ? 'Xfyun RTASR handshake failed' : 'Xfyun RTASR service rejected the request', payload);
          return;
        }
        if (payload.action === 'started') {
          if (started) return;
          started = true;
          clearTimeout(handshakeTimer);
          void sendAudio();
          return;
        }
        if (payload.action !== 'result') return;
        try {
          const segment = parseFinalSegment(payload.data, segmentOrder++);
          if (segment) {
            segments.set(segment.key, segment);
          }
        } catch {
          fail('Xfyun RTASR returned an invalid result');
        }
      });
      attach(socket, 'error', () => fail('Xfyun RTASR connection failed'));
      attach(socket, 'close', () => {
        if (settled) return;
        if (endSent && segments.size > 0) finishFromResults(true);
        else settle(new Error('Xfyun RTASR connection closed before completion'), undefined, {socketClosed: true});
      });

      handshakeTimer = setTimeout(() => fail('Xfyun RTASR handshake timed out'), this.handshakeTimeoutMs);
      signal?.addEventListener('abort', onAbort, {once: true});
      if (signal?.aborted) onAbort();
    });
  }
}
