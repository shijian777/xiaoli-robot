import {readTurnEvents} from './ndjson.mjs';

const TIMEOUT_MS = 90_000;
const REDACTED = '[REDACTED]';

export class AsrUnavailableError extends Error {
  constructor() {
    super('Audio transcription is unavailable from Agent Stack');
    this.name = 'AsrUnavailableError';
  }
}

export class ActiveTurnConflictError extends Error {
  constructor() {
    super('An Agent Stack turn is already active for this session');
    this.name = 'ActiveTurnConflictError';
  }
}

export class TurnFailedError extends Error {
  constructor(turnError) {
    super(turnError ? `Agent Stack turn failed: ${turnError.code}: ${turnError.message}` : 'Agent Stack turn did not complete successfully');
    this.name = 'TurnFailedError';
    this.turnError = turnError;
  }
}

function retryAfterMilliseconds(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eventMessage(event) {
  for (const value of [event.message, event.content, event.text, event.data?.message, event.data?.content, event.data?.text]) {
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Small Agent Stack transport. Turn POSTs are never retried: without a
 * server-issued idempotency guarantee, replaying one could duplicate effects.
 */
export class AgentStackClient {
  #baseUrl;
  #uak;
  #projectId;

  constructor({baseUrl, uak, projectId}) {
    this.#baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.#uak = String(uak);
    this.#projectId = String(projectId);
  }

  async listProjects() {
    const response = await this.#request('/api/console/projects', {method: 'GET'}, true);
    const body = await this.#jsonResponse(response);
    return body.projects ?? body;
  }

  async listAgents() {
    const response = await this.#request('/api/agents', {method: 'GET'}, true);
    const body = await this.#jsonResponse(response);
    return body.agents ?? body;
  }

  async createSession(agentId, {signal} = {}) {
    const response = await this.#request('/api/sessions', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({agentId}),
      signal
    });
    const body = await this.#jsonResponse(response);
    const sessionId = body.sessionId ?? body.id ?? body.session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('Agent Stack create-session response did not include a session id');
    return sessionId;
  }

  async runTextTurn(sessionId, text, {signal} = {}) {
    return this.#runTurn(sessionId, {
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({input: {type: 'text', text}})
    }, false, signal);
  }

  async runAudioTurn(sessionId, wav, name, {signal} = {}) {
    const body = new FormData();
    body.append('file', new Blob([wav], {type: 'audio/wav'}), name);
    return this.#runTurn(sessionId, {body}, true, signal);
  }

  async #runTurn(sessionId, options, audio, signal) {
    const response = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
      method: 'POST',
      ...options,
      signal
    });
    if (response.status === 409) throw new ActiveTurnConflictError();
    if (audio && response.status === 501) throw new AsrUnavailableError();
    this.#assertSuccess(response);
    if (!response.body) throw new TurnFailedError();

    const events = [];
    let turnError;
    let assistantMessage;
    let assistantMessageCount = 0;
    let finished;
    for await (const rawEvent of readTurnEvents(response.body)) {
      const event = this.#sanitize(rawEvent);
      events.push(event);
      if (event.type === 'assistant_message') {
        assistantMessageCount += 1;
        assistantMessage = eventMessage(event);
      }
      if (event.type === 'turn_error') {
        turnError = {
          code: typeof event.code === 'string' ? event.code : 'UNKNOWN',
          message: typeof event.message === 'string' ? event.message : 'Agent Stack turn failed'
        };
      }
      if (event.type === 'turn_finished') finished = event;
    }

    if (assistantMessageCount !== 1 || typeof assistantMessage !== 'string' || finished?.payload?.status !== 'succeeded') {
      throw new TurnFailedError(turnError);
    }
    return {assistantMessage, events, status: finished.payload.status};
  }

  async #request(path, options, retryable = false) {
    for (let attempt = 0; ; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(`${this.#baseUrl}${path}`, {
        ...options,
        headers: {
          authorization: `Bearer ${this.#uak}`,
          'x-agent9-project-id': this.#projectId,
          ...options.headers
        },
        signal
      });
      const shouldRetry = retryable && attempt === 0 && (response.status === 429 || response.status >= 500);
      if (!shouldRetry) return response;
      await response.body?.cancel();
      await sleep(retryAfterMilliseconds(response.headers.get('retry-after')));
    }
  }

  async #jsonResponse(response) {
    this.#assertSuccess(response);
    try {
      return await response.json();
    } catch {
      throw new Error('Agent Stack returned an invalid JSON response');
    }
  }

  #assertSuccess(response) {
    if (!response.ok) throw new Error(`Agent Stack request failed with HTTP ${response.status}`);
  }

  #sanitize(value) {
    if (typeof value === 'string') return value.replaceAll(this.#uak, REDACTED);
    if (Array.isArray(value)) return value.map((item) => this.#sanitize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#sanitize(item)]));
    }
    return value;
  }
}
