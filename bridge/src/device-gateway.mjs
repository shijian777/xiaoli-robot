import {timingSafeEqual, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {WebSocket, WebSocketServer} from 'ws';
import {pcmToWav, parsePcmWav} from './audio/wav.mjs';
import {CaseManager} from './case-manager.mjs';
import {decodeBinaryFrame, encodeBinaryFrame, FrameKind} from './protocol/binary-frame.mjs';
import {validateDeviceMessage, validateMediatorResult} from './protocol/schemas.mjs';

const RECORDING_STREAM = 2;
const VOICE_STREAM = 0;
const MAX_TTS_CHUNK_BYTES = 4096;
const MAX_TTS_PCM_BYTES = 1_920_000;
const DEFAULT_BACKPRESSURE_BYTES = 256 * 1024;
const DEFAULT_BACKPRESSURE_GRACE_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 500;
const DEFAULT_SHUTDOWN_CANCEL_MS = 3_750;
const DEFAULT_SHUTDOWN_CLOSE_MS = 250;
const TEMP_CLEANUP_RETRY_MS = 50;
const TEMP_CLEANUP_ATTEMPTS = 3;

export function createDeviceGateway(options = {}) {
  return new DeviceGateway(options);
}

class DeviceGateway {
  #deviceToken;
  #tempDir;
  #cases;
  #asr;
  #mediator;
  #tts;
  #createMediatorSession;
  #logger;
  #helloTimeoutMs;
  #heartbeatMs;
  #backpressureBytes;
  #backpressureGraceMs;
  #fs;
  #server;
  #wss;
  #devices = new Map();
  #connections = new Set();
  #activeWork = new Set();
  #ownedTempFiles = new Set();
  #ownedTempCaseIds = new Map();
  #abortController = new AbortController();
  #shutdownPromise;
  #listening = false;
  #stopping = false;

  constructor({
    deviceToken,
    tempDir,
    caseManager = new CaseManager(),
    asrService,
    mediatorService,
    ttsService,
    createMediatorSession,
    logger = console,
    helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    backpressureBytes = DEFAULT_BACKPRESSURE_BYTES,
    backpressureGraceMs = DEFAULT_BACKPRESSURE_GRACE_MS,
    fileSystem = fs
  } = {}) {
    assertNonEmptyString(deviceToken, 'deviceToken');
    assertNonEmptyString(tempDir, 'tempDir');
    if (!caseManager || typeof caseManager.startCase !== 'function') throw new TypeError('caseManager must manage cases');
    if (!asrService || typeof asrService.transcribe !== 'function') throw new TypeError('asrService must provide transcribe()');
    if (!mediatorService || typeof mediatorService.mediate !== 'function') throw new TypeError('mediatorService must provide mediate()');
    if (!ttsService || typeof ttsService.synthesize !== 'function') throw new TypeError('ttsService must provide synthesize()');
    if (typeof createMediatorSession !== 'function') throw new TypeError('createMediatorSession must be a function');
    assertPositiveFinite(helloTimeoutMs, 'helloTimeoutMs');
    assertPositiveFinite(heartbeatMs, 'heartbeatMs');
    assertPositiveFinite(backpressureBytes, 'backpressureBytes');
    assertPositiveFinite(backpressureGraceMs, 'backpressureGraceMs');
    for (const method of ['mkdir', 'open', 'rename', 'rm']) {
      if (typeof fileSystem?.[method] !== 'function') throw new TypeError(`fileSystem must provide ${method}()`);
    }

    this.#deviceToken = deviceToken;
    this.#tempDir = path.resolve(tempDir);
    this.#cases = caseManager;
    this.#asr = asrService;
    this.#mediator = mediatorService;
    this.#tts = ttsService;
    this.#createMediatorSession = createMediatorSession;
    this.#logger = logger;
    this.#helloTimeoutMs = helloTimeoutMs;
    this.#heartbeatMs = heartbeatMs;
    this.#backpressureBytes = backpressureBytes;
    this.#backpressureGraceMs = backpressureGraceMs;
    this.#fs = fileSystem;
  }

  async listen({host = '127.0.0.1', port = 0} = {}) {
    if (this.#listening) throw new Error('device gateway is already listening');
    if (this.#stopping) throw new Error('device gateway is stopping');
    await this.#fs.mkdir(this.#tempDir, {recursive: true});

    this.#server = createServer((request, response) => {
      response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      response.end('Not found');
    });
    this.#wss = new WebSocketServer({noServer: true, maxPayload: 128 * 1024});
    this.#server.on('upgrade', (request, socket, head) => {
      let pathname;
      try {
        pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      } catch {
        pathname = '';
      }
      if (pathname !== '/device' || this.#stopping) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(request, socket, head, (ws) => this.#wss.emit('connection', ws, request));
    });
    this.#wss.on('connection', (ws) => this.#accept(ws));

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.#server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.removeListener('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(port, host);
    });
    this.#listening = true;
    return this.address();
  }

  address() {
    const address = this.#server?.address();
    if (!address || typeof address === 'string') throw new Error('device gateway is not listening');
    return address;
  }

  async waitForIdle({timeoutMs} = {}) {
    const idle = (async () => {
      while (this.#activeWork.size > 0) {
        await Promise.allSettled([...this.#activeWork]);
      }
      return true;
    })();
    if (timeoutMs === undefined) return idle;
    return Promise.race([
      idle,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      })
    ]);
  }

  shutdown({
    graceMs = DEFAULT_SHUTDOWN_DRAIN_MS,
    cancelGraceMs = DEFAULT_SHUTDOWN_CANCEL_MS,
    closeGraceMs = DEFAULT_SHUTDOWN_CLOSE_MS
  } = {}) {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    for (const [name, value] of Object.entries({graceMs, cancelGraceMs, closeGraceMs})) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must not be negative`);
    }
    this.#stopping = true;
    this.#listening = false;
    this.#shutdownPromise = this.#performShutdown({graceMs, cancelGraceMs, closeGraceMs});
    return this.#shutdownPromise;
  }

  async #performShutdown({graceMs, cancelGraceMs, closeGraceMs}) {
    const serverClosed = this.#server
      ? new Promise((resolve) => this.#server.close(() => resolve()))
      : Promise.resolve();
    const drained = await this.waitForIdle({timeoutMs: graceMs});
    if (!drained) {
      this.#abortController.abort(new Error('Bridge shutting down'));
      await this.waitForIdle({timeoutMs: cancelGraceMs});
    }

    for (const connection of [...this.#connections]) {
      if (connection.ws.readyState === WebSocket.OPEN || connection.ws.readyState === WebSocket.CONNECTING) {
        connection.ws.close(1001, 'Bridge shutting down');
      }
    }
    await Promise.race([
      Promise.allSettled([...this.#connections].map(({closed}) => closed)),
      new Promise((resolve) => setTimeout(resolve, closeGraceMs))
    ]);
    for (const connection of [...this.#connections]) connection.ws.terminate();

    const websocketClosed = this.#wss
      ? new Promise((resolve) => this.#wss.close(() => resolve()))
      : Promise.resolve();
    await Promise.allSettled([serverClosed, websocketClosed]);
    await this.#removeOwnedTempFiles();
  }

  async #removeOwnedTempFiles() {
    const removed = await Promise.all([...this.#ownedTempFiles].map((candidate) => this.#tryRemoveOwnedTemp(candidate)));
    if (removed.some((success) => !success)) throw new Error('Bridge could not remove every owned temporary artifact');
  }

  async #removeOwnedTempFilesForCase(caseId) {
    const candidates = [...this.#ownedTempCaseIds]
      .filter(([, ownerCaseId]) => ownerCaseId === caseId)
      .map(([candidate]) => candidate);
    await Promise.all(candidates.map((candidate) => this.#tryRemoveOwnedTemp(candidate)));
  }

  async #removeTempWithRetry(candidate) {
    for (let attempt = 0; attempt < TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await this.#fs.rm(candidate, {force: true});
        return;
      } catch (error) {
        if (attempt === TEMP_CLEANUP_ATTEMPTS - 1 || !isLikelyWindowsFileLock(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, TEMP_CLEANUP_RETRY_MS));
      }
    }
  }

  async #tryRemoveOwnedTemp(candidate) {
    try {
      await this.#removeTempWithRetry(candidate);
      this.#forgetOwnedTemp(candidate);
      return true;
    } catch {
      return false;
    }
  }

  #ownTemp(candidate, caseId) {
    this.#ownedTempFiles.add(candidate);
    this.#ownedTempCaseIds.set(candidate, caseId);
  }

  #forgetOwnedTemp(candidate) {
    this.#ownedTempFiles.delete(candidate);
    this.#ownedTempCaseIds.delete(candidate);
  }

  #accept(ws) {
    if (this.#stopping) {
      ws.close(1001, 'Bridge shutting down');
      return;
    }
    let closeResolve;
    const connection = {
      ws,
      authenticated: false,
      device: null,
      inbound: Promise.resolve(),
      missedPongs: 0,
      awaitingPong: false,
      pressureTimer: undefined,
      closed: new Promise((resolve) => { closeResolve = resolve; })
    };
    this.#connections.add(connection);

    connection.helloTimer = setTimeout(() => {
      if (!connection.authenticated) ws.close(4001, 'hello required');
    }, this.#helloTimeoutMs);
    connection.helloTimer.unref?.();

    connection.heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (connection.awaitingPong) connection.missedPongs += 1;
      if (connection.missedPongs >= 2) {
        ws.terminate();
        return;
      }
      connection.awaitingPong = true;
      ws.ping();
    }, this.#heartbeatMs);
    connection.heartbeat.unref?.();

    ws.on('pong', () => {
      connection.awaitingPong = false;
      connection.missedPongs = 0;
    });
    ws.on('message', (data, isBinary) => {
      const inbound = connection.inbound
        .then(() => this.#route(connection, Buffer.from(data), isBinary))
        .catch((error) => this.#handleUnexpected(connection, error));
      connection.inbound = inbound;
      this.#trackWork(inbound);
    });
    ws.on('error', () => {});
    ws.once('close', () => {
      clearTimeout(connection.helloTimer);
      clearInterval(connection.heartbeat);
      this.#clearBackpressure(connection);
      this.#connections.delete(connection);
      connection.device?.sockets.delete(connection);
      if (connection.device &&
          connection.deviceGeneration ===
            connection.device.connectionGeneration) {
        this.#supersedeMediation(
          connection.device, 'Mediation connection closed');
      }
      if (connection.device?.activeRecording?.owner === connection) {
        const recording = connection.device.activeRecording;
        this.#failAndForgetRecording(
          connection.device, recording,
          'Recording connection closed before durable completion');
        connection.device.activeRecording = null;
      }
      closeResolve();
    });
  }

  async #route(connection, data, isBinary) {
    if (this.#stopping) return;
    if (!connection.authenticated) {
      if (isBinary) {
        connection.ws.close(4001, 'hello required');
        return;
      }
      const hello = parseJson(data);
      if (!hello || !validateDeviceMessage(hello) || hello.type !== 'hello') {
        connection.ws.close(4002, 'invalid hello');
        return;
      }
      if (!sameSecret(hello.token, this.#deviceToken)) {
        connection.ws.close(4003, 'authentication failed');
        return;
      }
      this.#authenticate(connection, hello);
      return;
    }

    if (!this.#isCurrentConnection(connection)) {
      connection.ws.close(4004, 'device connection superseded');
      return;
    }

    if (isBinary) await this.#routeBinary(connection, data);
    else await this.#routeControl(connection, parseJson(data));
  }

  #authenticate(connection, hello) {
    clearTimeout(connection.helloTimer);
    let device = this.#devices.get(hello.deviceId);
    if (!device) {
      device = {
        deviceId: hello.deviceId,
        acks: new Map(),
        messageFingerprints: new Map(),
        ackBindings: new Map(),
        segmentAcks: new Map(),
        segmentProgress: new Map(),
        segmentCommits: new Map(),
        activeRecording: null,
        queue: Promise.resolve(),
        mediatorSessions: new Map(),
        mediationController: null,
        mediationWork: null,
        connectionGeneration: 0,
        currentCaseId: null,
        caseAbortController: null,
        sockets: new Set()
      };
      this.#devices.set(hello.deviceId, device);
    }
    const fingerprint = messageFingerprint(hello);
    const existing = device.acks.get(hello.messageId);
    if (existing && device.messageFingerprints.get(hello.messageId) !== fingerprint) {
      connection.ws.close(4002, 'message id conflict');
      return;
    }
    connection.authenticated = true;
    connection.device = device;
    this.#supersedeMediation(device, 'Mediation connection superseded');
    device.connectionGeneration += 1;
    connection.deviceGeneration = device.connectionGeneration;
    for (const stale of [...device.sockets]) {
      device.sockets.delete(stale);
      if (device.activeRecording?.owner === stale) {
        this.#failAndForgetRecording(
          device, device.activeRecording,
          'Recording connection was superseded');
        device.activeRecording = null;
      }
      if (stale.ws.readyState === WebSocket.OPEN ||
          stale.ws.readyState === WebSocket.CONNECTING) {
        stale.ws.close(4004, 'device connection superseded');
      }
    }
    device.sockets.add(connection);
    const ack = existing ?? {
      v: 1,
      type: 'hello.ack',
      messageId: hello.messageId,
      deviceId: hello.deviceId,
      protocol: 1
    };
    this.#storeAck(device, hello, ack);
    this.#sendJson(connection, ack);
  }

  async #routeControl(connection, message) {
    if (!message || !validateDeviceMessage(message)) {
      this.#sendError(connection, 'invalid_message', false, 'Message did not match the device protocol');
      return;
    }
    if (message.type === 'hello') {
      if (!this.#replayMessage(connection, message)) {
        this.#sendError(connection, 'invalid_message', false, 'Hello is valid only as the first connection message');
      }
      return;
    }
    if (message.type === 'case.start') {
      if (!this.#replayMessage(connection, message)) this.#startCase(connection, message);
    }
    else if (message.type === 'mediate.request') this.#requestMediation(connection, message);
    else this.#sendError(connection, 'invalid_message', false, 'Speech controls must use binary stream frames');
  }

  #startCase(connection, message) {
    try {
      const previousCaseId = this.#cases.currentCaseId(connection.device.deviceId);
      this.#cases.startCase(connection.device.deviceId, message.caseId);
      if (previousCaseId && previousCaseId !== message.caseId) {
        this.#evictDeviceCase(connection.device, previousCaseId);
      }
      if (connection.device.currentCaseId !== message.caseId || !connection.device.caseAbortController) {
        connection.device.currentCaseId = message.caseId;
        connection.device.caseAbortController = new AbortController();
      }
      const ack = {v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true};
      this.#storeAck(connection.device, message, ack);
      this.#sendJson(connection, ack);
      this.#broadcastState(connection.device, 'waiting', message.caseId);
    } catch {
      this.#sendError(connection, 'case_conflict', false, 'Case could not be started');
    }
  }

  #evictDeviceCase(device, caseId) {
    if (device.currentCaseId === caseId) {
      device.caseAbortController?.abort(new Error('Case was replaced'));
      this.#supersedeMediation(device, 'Mediation case was replaced');
      device.currentCaseId = null;
      device.caseAbortController = null;
    }
    for (const [messageId, ack] of device.acks) {
      if (ack.caseId !== caseId) continue;
      device.acks.delete(messageId);
      device.messageFingerprints.delete(messageId);
      device.ackBindings.delete(messageId);
    }
    for (const [segmentId, record] of device.segmentAcks) {
      if (record.meta.caseId === caseId) device.segmentAcks.delete(segmentId);
    }
    for (const [segmentId, progress] of device.segmentProgress) {
      if (progress.meta.caseId === caseId) device.segmentProgress.delete(segmentId);
    }
    if (device.activeRecording?.meta?.caseId === caseId) device.activeRecording = null;
    device.mediatorSessions.delete(caseId);
    this.#asr.forgetCase?.(caseId);
    this.#trackWork(this.#removeOwnedTempFilesForCase(caseId));
  }

  async #routeBinary(connection, data) {
    let frame;
    try {
      frame = decodeBinaryFrame(data);
    } catch {
      this.#sendError(connection, 'invalid_frame', false, 'Audio frame was invalid');
      return;
    }
    if (frame.kind === FrameKind.CONTROL) return;
    if (frame.streamType !== RECORDING_STREAM) {
      this.#sendError(connection, 'invalid_stream_type', false, 'Only recording audio is accepted from a device');
      return;
    }
    if (frame.kind === FrameKind.STREAM_START) await this.#startSpeech(connection, frame);
    else if (frame.kind === FrameKind.STREAM_CHUNK) this.#appendSpeech(connection, frame);
    else if (frame.kind === FrameKind.STREAM_END) await this.#endSpeech(connection, frame);
    else this.#sendError(connection, 'invalid_frame_kind', false, 'Unsupported audio frame kind');
  }

  async #startSpeech(connection, frame) {
    const message = parseJson(frame.payload);
    const device = connection.device;
    const retainedMeta = retainedSegmentMeta(device, message?.segmentId);
    if (frame.sequence !== 0 || !message || !validateDeviceMessage(message) || message.type !== 'speech.start') {
      if (message?.type === 'speech.start' && retainedMeta && !sameSegmentMeta(retainedMeta, message)) {
        this.#sendError(connection, 'segment_conflict', false, 'Segment metadata conflicts with retained audio', message?.caseId, message?.segmentId);
        return;
      }
      this.#sendError(connection, 'invalid_speech_start', false, 'Speech start metadata was invalid', message?.caseId, message?.segmentId);
      return;
    }
    if (!this.#ownedCase(connection, message.caseId)) return;
    const committing = device.segmentCommits.get(message.segmentId);
    if (committing) {
      if (!sameSegmentMeta(committing.meta, message)) {
        this.#sendError(connection, 'segment_conflict', false,
          'Segment metadata conflicts with committing audio',
          message.caseId, message.segmentId);
        return;
      }
      await committing.promise;
      // The promise belongs to the segment, not to this socket. The replay
      // waiter may have disconnected (or been superseded) while durable I/O
      // was in progress; never resurrect that stale connection as stream
      // owner after the await boundary.
      if (!this.#isCurrentConnection(connection)) {
        return;
      }
      const completed = device.segmentAcks.get(message.segmentId);
      if (completed) {
        device.activeRecording = {
          owner: connection, replayAck: completed.ack, meta: completed.meta
        };
        this.#replayMessage(connection, message);
        return;
      }
      // A failed commit evicts its admission ACK and reopens the exact
      // failed CaseManager segment below for a from-zero replay.
    }
    if (device.acks.has(message.messageId)) {
      if (device.messageFingerprints.get(message.messageId) !== messageFingerprint(message)) {
        this.#replayMessage(connection, message);
        return;
      }
      const binding = device.ackBindings.get(message.messageId);
      if (binding && !sameSegmentMeta(binding, message)) {
        this.#sendError(connection, 'segment_conflict', false, 'Segment metadata conflicts with retained audio', message.caseId, message.segmentId);
        return;
      }
      const progress = device.segmentProgress.get(message.segmentId);
      const completed = device.segmentAcks.get(message.segmentId);
      if (progress) {
        if (device.activeRecording && device.activeRecording.owner !== connection) {
          this.#sendError(connection, 'audio_stream_active', true, 'Only one recording stream may be active', message.caseId, message.segmentId);
          return;
        }
        device.activeRecording = {owner: connection, progress, meta: progress.meta};
      } else if (completed) {
        if (!sameSegmentMeta(completed.meta, message)) {
          this.#sendError(connection, 'segment_conflict', false, 'Segment metadata conflicts with retained audio', message.caseId, message.segmentId);
          return;
        }
        device.activeRecording = {owner: connection, replayAck: completed.ack, meta: completed.meta};
      }
      this.#replayMessage(connection, message);
      return;
    }
    if (device.activeRecording) {
      this.#sendError(connection, 'audio_stream_active', true, 'Only one recording stream may be active', message.caseId, message.segmentId);
      return;
    }
    const completedRecord = device.segmentAcks.get(message.segmentId);
    if (completedRecord) {
      if (!sameSegmentMeta(completedRecord.meta, message)) {
        this.#sendError(connection, 'segment_conflict', false, 'Segment metadata conflicts with retained audio', message.caseId, message.segmentId);
        return;
      }
      device.activeRecording = {owner: connection, replayAck: completedRecord.ack, meta: completedRecord.meta};
      this.#storeAck(device, message, completedRecord.ack, completedRecord.meta);
      this.#sendJson(connection, completedRecord.ack);
      return;
    }
    try {
      this.#cases.startSegment(message);
      let progress = device.segmentProgress.get(message.segmentId);
      if (!progress) {
        progress = {meta: segmentBinding(message), nextSequence: 0, receivedBytes: 0};
        device.segmentProgress.set(message.segmentId, progress);
      } else if (!sameSegmentMeta(progress.meta, message)) {
        throw new Error('segment metadata conflict');
      }
      device.activeRecording = {owner: connection, progress, meta: progress.meta};
      const ack = {
        v: 1,
        type: 'ack',
        messageId: message.messageId,
        caseId: message.caseId,
        segmentId: message.segmentId,
        accepted: true
      };
      this.#storeAck(device, message, ack, message);
      this.#sendJson(connection, ack);
      this.#broadcastState(device, 'recording', message.caseId, message.segmentId);
    } catch (error) {
      if (error?.code === 'case_segment_limit_exceeded') {
        this.#sendError(connection, error.code, false, 'This case already has the maximum number of recordings', message.caseId, message.segmentId);
        return;
      }
      this.#sendError(connection, 'segment_conflict', false, 'Segment could not be started', message.caseId, message.segmentId);
    }
  }

  #appendSpeech(connection, frame) {
    const recording = connection.device.activeRecording;
    if (!recording || recording.owner !== connection) {
      this.#sendError(connection, 'audio_stream_missing', true, 'No recording stream is active');
      return;
    }
    if (recording.replayAck) return;
    const {progress, meta} = recording;
    if (frame.sequence > progress.nextSequence) {
      this.#failRecording(connection, meta.segmentId, 'audio_sequence_gap', 'A recording audio sequence is missing');
      return;
    }
    try {
      this.#cases.appendChunk(meta.segmentId, frame.sequence, frame.payload);
      if (frame.sequence === progress.nextSequence) {
        progress.nextSequence += 1;
        progress.receivedBytes += frame.payload.length;
      }
      this.#applyBackpressure(connection);
    } catch (error) {
      if (error?.code === 'audio_size_limit_exceeded') {
        this.#failRecording(connection, meta.segmentId, error.code, 'Recording audio exceeded its allowed duration');
        return;
      }
      const code = /missing audio sequence/i.test(error?.message) ? 'audio_sequence_gap' : 'invalid_audio';
      this.#failRecording(connection, meta.segmentId, code, 'Recording audio was invalid');
    }
  }

  async #endSpeech(connection, frame) {
    const message = parseJson(frame.payload);
    if (!message || !validateDeviceMessage(message) || message.type !== 'speech.end') {
      this.#sendError(connection, 'invalid_speech_end', false, 'Speech end metadata was invalid', message?.caseId, message?.segmentId);
      return;
    }
    const device = connection.device;
    if (!this.#ownedCase(connection, message.caseId)) return;
    const exactReplay = device.acks.has(message.messageId) &&
      device.messageFingerprints.get(message.messageId) === messageFingerprint(message);
    if (this.#replayMessage(connection, message)) {
      const recording = device.activeRecording;
      if (exactReplay && recording?.owner === connection && recording.replayAck &&
          message.caseId === recording.meta.caseId && message.segmentId === recording.meta.segmentId) {
        // An exact-ID firmware replay can hit the cached durable ACK before
        // normal completion handling.  It still owns the replay stream opened
        // by speech.start, so release that binding before accepting another
        // segment on this connection.
        device.activeRecording = null;
      }
      return;
    }
    const recording = device.activeRecording;
    if (!recording || recording.owner !== connection) {
      const replay = device.segmentAcks.get(message.segmentId);
      if (replay && replay.meta.caseId === message.caseId) {
        this.#storeAck(device, message, replay.ack, replay.meta);
        this.#sendJson(connection, replay.ack);
      } else {
        this.#sendError(connection, 'audio_stream_missing', true, 'No recording stream is active', message.caseId, message.segmentId);
      }
      return;
    }
    if (recording.replayAck) {
      if (message.caseId !== recording.meta.caseId || message.segmentId !== recording.meta.segmentId) {
        this.#sendError(connection, 'segment_conflict', false, 'Replay completion did not match the active segment', message.caseId, message.segmentId);
        return;
      }
      this.#storeAck(device, message, recording.replayAck, recording.meta);
      this.#sendJson(connection, recording.replayAck);
      device.activeRecording = null;
      return;
    }
    const {progress, meta} = recording;
    const expectedLast = progress.nextSequence - 1;
    if (message.caseId !== meta.caseId || message.segmentId !== meta.segmentId ||
        !message.complete || (frame.flags & 1) !== 1 || frame.sequence !== message.lastSequence ||
        expectedLast < 0 || message.lastSequence !== expectedLast) {
      const gap = expectedLast < 0 || message.lastSequence > expectedLast;
      this.#failRecording(connection, meta.segmentId, gap ? 'audio_sequence_gap' : 'audio_incomplete',
        gap ? 'A recording audio sequence is missing' : 'Recording completion metadata did not match');
      return;
    }
    if (message.bytes !== progress.receivedBytes) {
      this.#failRecording(connection, meta.segmentId, 'audio_size_mismatch', 'Recording byte count did not match');
      return;
    }

    // From this point the end handler owns the segment terminal transition.
    // A socket close may detach delivery, but must not race the durable write
    // by converting queued audio into an orphaned failed segment.
    recording.committing = true;
    const commit = this.#beginSegmentCommit(device, meta);

    let completed;
    let transcriptionSegment;
    let wavPath;
    const signal = this.#caseSignal(device, meta.caseId);
    try {
      this.#assertRunning(signal);
      completed = this.#cases.endSegment(meta.segmentId);
      try {
        wavPath = await this.#writeDurableWav(completed.pcm, completed.audio, meta.caseId, signal);
      } finally {
        completed.pcm.fill(0);
      }
      this.#cases.releaseAudio(meta.segmentId);
      transcriptionSegment = {
        caseId: completed.caseId,
        segmentId: completed.segmentId,
        speaker: completed.speaker,
        audio: completed.audio
      };
    } catch (error) {
      if (wavPath) {
        await this.#tryRemoveOwnedTemp(wavPath);
      }
      if (this.#stopping || signal.aborted) {
        device.activeRecording = null;
        device.segmentProgress.delete(meta.segmentId);
        this.#finishSegmentCommit(device, meta.segmentId, commit);
        return;
      }
      this.#failAndForgetRecording(device, recording, 'WAV assembly failed', true);
      device.activeRecording = null;
      this.#finishSegmentCommit(device, meta.segmentId, commit);
      this.#sendError(connection, 'audio_write_failed', true, 'Recording could not be stored', meta.caseId, meta.segmentId);
      this.#logger.error?.('Gateway WAV write failed', {segmentId: meta.segmentId, errorCode: error?.code ?? 'UNKNOWN'});
      return;
    }
    if (this.#stopping || signal.aborted) {
      await this.#tryRemoveOwnedTemp(wavPath);
      device.activeRecording = null;
      device.segmentProgress.delete(meta.segmentId);
      this.#finishSegmentCommit(device, meta.segmentId, commit);
      return;
    }

    const ack = {
      v: 1,
      type: 'ack',
      messageId: message.messageId,
      caseId: meta.caseId,
      segmentId: meta.segmentId,
      bytes: progress.receivedBytes,
      durable: true
    };
    this.#storeAck(device, message, ack, meta);
    device.segmentAcks.set(meta.segmentId, {ack, meta: segmentBinding(meta)});
    device.segmentProgress.delete(meta.segmentId);
    device.activeRecording = null;
    this.#finishSegmentCommit(device, meta.segmentId, commit);
    this.#sendJson(connection, ack);
    this.#broadcastState(device, 'transcribing', meta.caseId, meta.segmentId);
    if (!this.#enqueue(device, (operationSignal) => this.#transcribe(device, transcriptionSegment, wavPath, operationSignal), meta.caseId)) {
      await this.#tryRemoveOwnedTemp(wavPath);
    }
  }

  #failRecording(connection, segmentId, code, message) {
    const device = connection.device;
    const recording = device.activeRecording;
    const meta = recording?.meta?.segmentId === segmentId
      ? recording.meta
      : device.segmentProgress.get(segmentId)?.meta;
    this.#failAndForgetRecording(device, {meta}, message);
    device.activeRecording = null;
    this.#sendError(connection, code, true, message, meta?.caseId, segmentId);
    this.#broadcastState(device, 'error', meta?.caseId, segmentId);
  }

  #failAndForgetRecording(device, recording, failure, force = false) {
    const segmentId = recording?.meta?.segmentId;
    if (!segmentId || recording?.replayAck || (recording?.committing && !force)) return;
    try {
      this.#cases.failSegment(segmentId, failure);
    } catch {
      // The protocol error remains stable even if the segment was terminal.
    }
    device.segmentProgress.delete(segmentId);
    for (const [messageId, binding] of device.ackBindings) {
      if (binding?.segmentId !== segmentId) continue;
      device.acks.delete(messageId);
      device.messageFingerprints.delete(messageId);
      device.ackBindings.delete(messageId);
    }
  }

  #beginSegmentCommit(device, meta) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const commit = {meta: segmentBinding(meta), promise, resolve};
    device.segmentCommits.set(meta.segmentId, commit);
    return commit;
  }

  #finishSegmentCommit(device, segmentId, commit) {
    if (device.segmentCommits.get(segmentId) === commit) {
      device.segmentCommits.delete(segmentId);
    }
    commit.resolve();
  }

  async #writeDurableWav(pcm, audio, caseId, signal) {
    this.#assertRunning(signal);
    const wav = pcmToWav(pcm, audio);
    const parsed = parsePcmWav(wav);
    if (!parsed.pcm.equals(pcm)) throw new Error('assembled WAV validation failed');
    const basename = `segment-${randomUUID()}`;
    const temporaryPath = path.join(this.#tempDir, `${basename}.part`);
    const finalPath = path.join(this.#tempDir, `${basename}.wav`);
    this.#ownTemp(temporaryPath, caseId);
    let handle;
    try {
      handle = await this.#fs.open(temporaryPath, 'wx', 0o600);
      this.#assertRunning(signal);
      await handle.writeFile(wav, {signal});
      this.#assertRunning(signal);
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.#assertRunning(signal);
      await this.#fs.rename(temporaryPath, finalPath);
      this.#forgetOwnedTemp(temporaryPath);
      this.#ownTemp(finalPath, caseId);
      if (this.#stopping || signal?.aborted) {
        await this.#tryRemoveOwnedTemp(finalPath);
        throw abortError();
      }
      return finalPath;
    } catch (error) {
      await handle?.close();
      await this.#tryRemoveOwnedTemp(temporaryPath);
      throw error;
    }
  }

  async #transcribe(device, segment, wavPath, signal) {
    try {
      this.#assertRunning(signal);
      this.#cases.beginTranscription(segment.segmentId);
      const transcript = await this.#asr.transcribe(wavPath, {
        caseId: segment.caseId,
        segmentId: segment.segmentId,
        signal
      });
      this.#assertRunning(signal);
      this.#cases.saveTranscript(segment.segmentId, transcript);
      this.#broadcastJson(device, {
        v: 1,
        type: 'transcript.saved',
        caseId: segment.caseId,
        segmentId: segment.segmentId,
        speaker: segment.speaker
      });
      this.#broadcastState(device, 'waiting', segment.caseId, segment.segmentId);
    } catch (error) {
      if (this.#stopping || signal?.aborted) return;
      try {
        this.#cases.failSegment(segment.segmentId, 'Transcription failed');
      } catch {}
      this.#broadcastError(device, 'transcription_failed', true, 'Recording transcription failed', segment.caseId, segment.segmentId);
      // A retryable ASR failure is terminal for this segment, but not for the
      // case.  Publish the stable waiting state so hardware can leave its
      // recoverable error UI and let the same speaker record again.
      this.#broadcastState(device, 'waiting', segment.caseId, segment.segmentId);
      this.#logger.error?.('Gateway transcription failed', {caseId: segment.caseId, segmentId: segment.segmentId, errorName: error?.name ?? 'Error'});
    } finally {
      await this.#tryRemoveOwnedTemp(wavPath);
    }
  }

  #requestMediation(connection, message) {
    const device = connection.device;
    if (!this.#ownedCase(connection, message.caseId)) return;
    if (this.#replayMessage(connection, message)) return;
    const ack = {v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true};
    this.#storeAck(device, message, ack);
    this.#sendJson(connection, ack);
    const deliveryGeneration = connection.deviceGeneration;
    this.#startMediation(
      device, message.caseId, deliveryGeneration);
  }

  #startMediation(device, caseId, deliveryGeneration) {
    if (this.#stopping || this.#abortController.signal.aborted) return null;
    this.#supersedeMediation(device, 'Mediation request superseded');
    const controller = new AbortController();
    device.mediationController = controller;
    const signal = AbortSignal.any([
      this.#caseSignal(device, caseId), controller.signal
    ]);
    const work = Promise.resolve()
      .then(() => this.#mediate(
        device, caseId, signal, deliveryGeneration, controller))
      .finally(() => {
        if (device.mediationWork === work) {
          device.mediationWork = null;
          device.mediationController = null;
        }
      });
    device.mediationWork = work;
    this.#trackWork(work);
    return work;
  }

  #supersedeMediation(device, reason) {
    device.mediationController?.abort(new Error(reason));
    if (device.mediationWork) this.#activeWork.delete(device.mediationWork);
    device.mediationController = null;
    device.mediationWork = null;
    // A session promise can itself be the non-cooperative provider call. Do
    // not let a stale pending session get reused by the replacement lane.
    device.mediatorSessions.clear();
  }

  #mediationCurrent(device, deliveryGeneration, controller) {
    return !this.#stopping && !controller.signal.aborted &&
      device.connectionGeneration === deliveryGeneration &&
      device.mediationController === controller;
  }

  async #mediate(device, caseId, signal, deliveryGeneration, controller) {
    if (this.#stopping || signal?.aborted ||
        !this.#mediationCurrent(
          device, deliveryGeneration, controller)) return;
    let snapshot;
    try {
      snapshot = this.#cases.snapshot(caseId);
    } catch {
      if (this.#mediationCurrent(device, deliveryGeneration, controller)) {
        this.#broadcastError(device, 'case_not_found', false, 'Case does not exist', caseId);
      }
      return;
    }
    if (snapshot.deviceId !== device.deviceId) {
      if (this.#mediationCurrent(device, deliveryGeneration, controller)) {
        this.#broadcastError(device, 'case_forbidden', false, 'Case belongs to another device', caseId);
      }
      return;
    }
    if (!snapshot.canMediate) {
      if (this.#mediationCurrent(device, deliveryGeneration, controller)) {
        this.#broadcastError(device, 'mediation_not_ready', true, 'Both A and B need saved transcripts', caseId);
      }
      return;
    }

    this.#broadcastState(device, 'mediating', caseId);
    try {
      const sessionId = await this.#mediatorSession(device, caseId, signal);
      this.#assertRunning(signal);
      const result = await this.#mediator.mediate(snapshot, sessionId, {signal});
      this.#assertRunning(signal);
      if (!validateMediatorResult(result)) {
        throw new Error('mediation result failed canonical validation');
      }
      if (!this.#mediationCurrent(device, deliveryGeneration, controller)) return;
      const pcm = await this.#tts.synthesize(result.spokenText, {signal});
      this.#assertRunning(signal);
      if (!this.#mediationCurrent(device, deliveryGeneration, controller)) return;
      if (!Buffer.isBuffer(pcm) || pcm.length === 0 ||
          pcm.length > MAX_TTS_PCM_BYTES || pcm.length % 2 !== 0) {
        throw new Error('TTS returned invalid PCM');
      }
      const chunks = Math.ceil(pcm.length / MAX_TTS_CHUNK_BYTES);
      if (chunks > 0x10000) throw new Error('TTS PCM exceeds the stream sequence space');

      this.#broadcastState(device, 'playing', caseId);
      this.#broadcastJson(device, {
        v: 1,
        type: 'audio.start',
        caseId,
        audio: {sampleRate: 16000, bits: 16, channels: 1},
        bytes: pcm.length
      });
      for (let sequence = 0, offset = 0; offset < pcm.length; sequence += 1, offset += MAX_TTS_CHUNK_BYTES) {
        this.#broadcastBinary(device, encodeBinaryFrame({
          kind: FrameKind.STREAM_CHUNK,
          streamType: VOICE_STREAM,
          flags: 0,
          sequence,
          payload: pcm.subarray(offset, offset + MAX_TTS_CHUNK_BYTES)
        }));
      }
      this.#broadcastJson(device, {
        v: 1,
        type: 'audio.end',
        caseId,
        bytes: pcm.length,
        lastSequence: Math.max(0, chunks - 1),
        complete: true
      });
      this.#broadcastState(device, 'waiting', caseId);
    } catch (error) {
      if (this.#stopping || signal?.aborted ||
          !this.#mediationCurrent(
            device, deliveryGeneration, controller)) return;
      this.#broadcastError(device, 'mediation_failed', true, 'Mediation or speech synthesis failed', caseId);
      this.#logger.error?.('Gateway mediation failed', {caseId, errorName: error?.name ?? 'Error'});
    }
  }

  async #mediatorSession(device, caseId, signal) {
    let pending = device.mediatorSessions.get(caseId);
    if (!pending) {
      pending = Promise.resolve(this.#createMediatorSession(caseId, {signal}));
      device.mediatorSessions.set(caseId, pending);
    }
    try {
      const sessionId = await pending;
      assertNonEmptyString(sessionId, 'mediator session id');
      return sessionId;
    } catch (error) {
      if (device.mediatorSessions.get(caseId) === pending) device.mediatorSessions.delete(caseId);
      throw error;
    }
  }

  #enqueue(device, operation, caseId) {
    if (this.#stopping || this.#abortController.signal.aborted) return null;
    const signal = this.#caseSignal(device, caseId);
    const work = device.queue.catch(() => {}).then(() => {
      if (this.#stopping || signal.aborted) return undefined;
      return operation(signal);
    });
    device.queue = work;
    this.#trackWork(work);
    return work;
  }

  #trackWork(work) {
    this.#activeWork.add(work);
    void work.then(
      () => this.#activeWork.delete(work),
      () => this.#activeWork.delete(work)
    );
    return work;
  }

  #assertRunning(signal) {
    if (this.#stopping || signal?.aborted) throw abortError();
  }

  #caseSignal(device, caseId) {
    const caseSignal = device.currentCaseId === caseId ? device.caseAbortController?.signal : AbortSignal.abort();
    return caseSignal ? AbortSignal.any([this.#abortController.signal, caseSignal]) : this.#abortController.signal;
  }

  #ownedCase(connection, caseId) {
    let snapshot;
    try {
      snapshot = this.#cases.snapshot(caseId);
    } catch {
      this.#sendError(connection, 'case_not_found', false, 'Case does not exist', caseId);
      return false;
    }
    if (snapshot.deviceId !== connection.device.deviceId) {
      this.#sendError(connection, 'case_forbidden', false, 'Case belongs to another device', caseId);
      return false;
    }
    return true;
  }

  #isCurrentConnection(connection) {
    const device = connection.device;
    return connection.authenticated && device &&
      connection.ws.readyState === WebSocket.OPEN &&
      connection.deviceGeneration === device.connectionGeneration &&
      device.sockets.has(connection);
  }

  #storeAck(device, message, ack, binding) {
    device.acks.set(message.messageId, ack);
    device.messageFingerprints.set(message.messageId, messageFingerprint(message));
    if (binding) device.ackBindings.set(message.messageId, segmentBinding(binding));
    else device.ackBindings.delete(message.messageId);
  }

  #replayMessage(connection, message) {
    const ack = connection.device.acks.get(message.messageId);
    if (!ack) return false;
    if (connection.device.messageFingerprints.get(message.messageId) !== messageFingerprint(message)) {
      this.#sendError(connection, 'message_id_conflict', false, 'messageId was reused with different content');
      return true;
    }
    this.#sendJson(connection, ack);
    return true;
  }

  #sendError(connection, code, retryable, message, caseId, segmentId) {
    this.#sendJson(connection, errorMessage(code, retryable, message, caseId, segmentId));
  }

  #broadcastError(device, code, retryable, message, caseId, segmentId) {
    this.#broadcastJson(device, errorMessage(code, retryable, message, caseId, segmentId));
  }

  #broadcastState(device, state, caseId, segmentId) {
    this.#broadcastJson(device, compact({v: 1, type: 'state', state, caseId, segmentId}));
  }

  #sendJson(connection, message) {
    if (this.#stopping) return;
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    connection.ws.send(JSON.stringify(message));
    this.#applyBackpressure(connection);
  }

  #broadcastJson(device, message) {
    for (const connection of device.sockets) this.#sendJson(connection, message);
  }

  #broadcastBinary(device, payload) {
    if (this.#stopping) return;
    for (const connection of device.sockets) {
      if (connection.ws.readyState !== WebSocket.OPEN) continue;
      connection.ws.send(payload, {binary: true});
      this.#applyBackpressure(connection);
    }
  }

  #applyBackpressure(connection) {
    if (connection.ws.bufferedAmount <= this.#backpressureBytes) return;
    connection.ws._socket?.pause?.();
    if (connection.pressureTimer !== undefined) return;
    const startedAt = Date.now();
    const pollMs = Math.max(10, Math.min(100, Math.floor(this.#backpressureGraceMs / 10)));
    connection.pressureTimer = setInterval(() => {
      if (connection.ws.bufferedAmount <= this.#backpressureBytes) {
        this.#clearBackpressure(connection);
        return;
      }
      if (Date.now() - startedAt >= this.#backpressureGraceMs) {
        this.#clearBackpressure(connection, false);
        connection.ws.close(1011, 'backpressure timeout');
      }
    }, pollMs);
    connection.pressureTimer.unref?.();
  }

  #clearBackpressure(connection, resume = true) {
    if (connection.pressureTimer !== undefined) clearInterval(connection.pressureTimer);
    connection.pressureTimer = undefined;
    if (resume) connection.ws._socket?.resume?.();
  }

  #handleUnexpected(connection, error) {
    this.#logger.error?.('Gateway message handling failed', {errorName: error?.name ?? 'Error'});
    this.#sendError(connection, 'internal_error', true, 'Bridge could not process the message');
  }
}

function parseJson(data) {
  try {
    return JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
}

function sameSecret(candidate, expected) {
  if (typeof candidate !== 'string') return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameSegmentMeta(left, right) {
  return Boolean(left && right && left.audio && right.audio) &&
    left.caseId === right.caseId && left.segmentId === right.segmentId && left.speaker === right.speaker &&
    left.audio.sampleRate === right.audio.sampleRate && left.audio.bits === right.audio.bits && left.audio.channels === right.audio.channels;
}

function segmentBinding(meta) {
  return Object.freeze({
    caseId: meta.caseId,
    segmentId: meta.segmentId,
    speaker: meta.speaker,
    audio: Object.freeze({
      sampleRate: meta.audio.sampleRate,
      bits: meta.audio.bits,
      channels: meta.audio.channels
    })
  });
}

function retainedSegmentMeta(device, segmentId) {
  if (typeof segmentId !== 'string') return undefined;
  return device.segmentProgress.get(segmentId)?.meta ?? device.segmentAcks.get(segmentId)?.meta;
}

function messageFingerprint(message) {
  return JSON.stringify(sortJson(message));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function errorMessage(code, retryable, message, caseId, segmentId) {
  return compact({v: 1, type: 'error', code, retryable, message, caseId, segmentId});
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
}

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
}

function isLikelyWindowsFileLock(error) {
  return error?.code === 'EBUSY' || error?.code === 'EACCES' || error?.code === 'EPERM';
}

function abortError() {
  const error = new Error('Bridge operation aborted');
  error.name = 'AbortError';
  return error;
}
