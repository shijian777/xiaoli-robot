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
const DEFAULT_BACKPRESSURE_BYTES = 256 * 1024;
const DEFAULT_BACKPRESSURE_GRACE_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;

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
  #server;
  #wss;
  #devices = new Map();
  #connections = new Set();
  #activeWork = new Set();
  #ownedTempFiles = new Set();
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
    backpressureGraceMs = DEFAULT_BACKPRESSURE_GRACE_MS
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
  }

  async listen({host = '127.0.0.1', port = 0} = {}) {
    if (this.#listening) throw new Error('device gateway is already listening');
    if (this.#stopping) throw new Error('device gateway is stopping');
    await fs.mkdir(this.#tempDir, {recursive: true});

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
    })();
    if (timeoutMs === undefined) return idle;
    return Promise.race([
      idle,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  }

  async shutdown({graceMs = 5_000} = {}) {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#listening = false;

    const serverClosed = this.#server
      ? new Promise((resolve) => this.#server.close(() => resolve()))
      : Promise.resolve();
    await this.waitForIdle({timeoutMs: graceMs});

    for (const connection of [...this.#connections]) {
      if (connection.ws.readyState === WebSocket.OPEN || connection.ws.readyState === WebSocket.CONNECTING) {
        connection.ws.close(1001, 'Bridge shutting down');
      }
    }
    await Promise.race([
      Promise.allSettled([...this.#connections].map(({closed}) => closed)),
      new Promise((resolve) => setTimeout(resolve, 250))
    ]);
    for (const connection of [...this.#connections]) connection.ws.terminate();

    const websocketClosed = this.#wss
      ? new Promise((resolve) => this.#wss.close(() => resolve()))
      : Promise.resolve();
    await Promise.allSettled([serverClosed, websocketClosed]);
    await Promise.allSettled([...this.#ownedTempFiles].map((candidate) => fs.rm(candidate, {force: true})));
    this.#ownedTempFiles.clear();
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
      connection.inbound = connection.inbound
        .then(() => this.#route(connection, Buffer.from(data), isBinary))
        .catch((error) => this.#handleUnexpected(connection, error));
    });
    ws.on('error', () => {});
    ws.once('close', () => {
      clearTimeout(connection.helloTimer);
      clearInterval(connection.heartbeat);
      this.#clearBackpressure(connection);
      this.#connections.delete(connection);
      connection.device?.sockets.delete(connection);
      if (connection.device?.activeRecording?.owner === connection) {
        connection.device.activeRecording = null;
      }
      closeResolve();
    });
  }

  async #route(connection, data, isBinary) {
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
        segmentAcks: new Map(),
        segmentProgress: new Map(),
        activeRecording: null,
        queue: Promise.resolve(),
        mediatorSessions: new Map(),
        sockets: new Set()
      };
      this.#devices.set(hello.deviceId, device);
    }
    connection.authenticated = true;
    connection.device = device;
    device.sockets.add(connection);
    const ack = device.acks.get(hello.messageId) ?? {
      v: 1,
      type: 'hello.ack',
      messageId: hello.messageId,
      deviceId: hello.deviceId,
      protocol: 1
    };
    device.acks.set(hello.messageId, ack);
    this.#sendJson(connection, ack);
  }

  async #routeControl(connection, message) {
    if (!message || !validateDeviceMessage(message) || message.type === 'hello') {
      this.#sendError(connection, 'invalid_message', false, 'Message did not match the device protocol');
      return;
    }
    const replay = connection.device.acks.get(message.messageId);
    if (replay) {
      this.#sendJson(connection, replay);
      return;
    }
    if (message.type === 'case.start') this.#startCase(connection, message);
    else if (message.type === 'mediate.request') this.#requestMediation(connection, message);
    else this.#sendError(connection, 'invalid_message', false, 'Speech controls must use binary stream frames');
  }

  #startCase(connection, message) {
    try {
      this.#cases.startCase(connection.device.deviceId, message.caseId);
      const ack = {v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true};
      connection.device.acks.set(message.messageId, ack);
      this.#sendJson(connection, ack);
      this.#broadcastState(connection.device, 'waiting', message.caseId);
    } catch {
      this.#sendError(connection, 'case_conflict', false, 'Case could not be started');
    }
  }

  async #routeBinary(connection, data) {
    let frame;
    try {
      frame = decodeBinaryFrame(data);
    } catch {
      this.#sendError(connection, 'invalid_frame', false, 'Audio frame was invalid');
      return;
    }
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
    if (frame.sequence !== 0 || !message || !validateDeviceMessage(message) || message.type !== 'speech.start') {
      this.#sendError(connection, 'invalid_speech_start', false, 'Speech start metadata was invalid');
      return;
    }
    const device = connection.device;
    const messageReplay = device.acks.get(message.messageId);
    if (messageReplay) {
      this.#sendJson(connection, messageReplay);
      return;
    }
    if (device.activeRecording) {
      this.#sendError(connection, 'audio_stream_active', true, 'Only one recording stream may be active');
      return;
    }
    const completedAck = device.segmentAcks.get(message.segmentId);
    if (completedAck) {
      device.activeRecording = {owner: connection, replayAck: completedAck, meta: message};
      device.acks.set(message.messageId, completedAck);
      this.#sendJson(connection, completedAck);
      return;
    }
    try {
      this.#cases.startSegment(message);
      let progress = device.segmentProgress.get(message.segmentId);
      if (!progress) {
        progress = {meta: message, nextSequence: 0, receivedBytes: 0};
        device.segmentProgress.set(message.segmentId, progress);
      } else if (!sameSegmentMeta(progress.meta, message)) {
        throw new Error('segment metadata conflict');
      }
      device.activeRecording = {owner: connection, progress, meta: message};
      const ack = {
        v: 1,
        type: 'ack',
        messageId: message.messageId,
        caseId: message.caseId,
        segmentId: message.segmentId,
        accepted: true
      };
      device.acks.set(message.messageId, ack);
      this.#sendJson(connection, ack);
      this.#broadcastState(device, 'recording', message.caseId, message.segmentId);
    } catch {
      this.#sendError(connection, 'segment_conflict', false, 'Segment could not be started');
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
      const code = /missing audio sequence/i.test(error?.message) ? 'audio_sequence_gap' : 'invalid_audio';
      this.#failRecording(connection, meta.segmentId, code, 'Recording audio was invalid');
    }
  }

  async #endSpeech(connection, frame) {
    const message = parseJson(frame.payload);
    if (!message || !validateDeviceMessage(message) || message.type !== 'speech.end') {
      this.#sendError(connection, 'invalid_speech_end', false, 'Speech end metadata was invalid');
      return;
    }
    const device = connection.device;
    const recording = device.activeRecording;
    if (!recording || recording.owner !== connection) {
      const replay = device.segmentAcks.get(message.segmentId) ?? device.acks.get(message.messageId);
      if (replay) {
        device.acks.set(message.messageId, replay);
        this.#sendJson(connection, replay);
      } else {
        this.#sendError(connection, 'audio_stream_missing', true, 'No recording stream is active');
      }
      return;
    }
    if (recording.replayAck) {
      device.acks.set(message.messageId, recording.replayAck);
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

    let completed;
    let wavPath;
    try {
      completed = this.#cases.endSegment(meta.segmentId);
      wavPath = await this.#writeDurableWav(completed.pcm, completed.audio);
    } catch (error) {
      this.#cases.failSegment(meta.segmentId, 'WAV assembly failed');
      device.activeRecording = null;
      this.#sendError(connection, 'audio_write_failed', true, 'Recording could not be stored');
      this.#logger.error?.('Gateway WAV write failed', {segmentId: meta.segmentId, errorCode: error?.code ?? 'UNKNOWN'});
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
    device.acks.set(message.messageId, ack);
    device.segmentAcks.set(meta.segmentId, ack);
    device.segmentProgress.delete(meta.segmentId);
    device.activeRecording = null;
    this.#sendJson(connection, ack);
    this.#broadcastState(device, 'transcribing', meta.caseId, meta.segmentId);
    this.#enqueue(device, () => this.#transcribe(device, completed, wavPath));
  }

  #failRecording(connection, segmentId, code, message) {
    try {
      this.#cases.failSegment(segmentId, message);
    } catch {
      // The protocol error remains stable even if the segment was already terminal.
    }
    connection.device.activeRecording = null;
    connection.device.segmentProgress.delete(segmentId);
    this.#sendError(connection, code, true, message);
    this.#broadcastState(connection.device, 'error', undefined, segmentId);
  }

  async #writeDurableWav(pcm, audio) {
    const wav = pcmToWav(pcm, audio);
    const parsed = parsePcmWav(wav);
    if (!parsed.pcm.equals(pcm)) throw new Error('assembled WAV validation failed');
    const basename = `segment-${randomUUID()}`;
    const temporaryPath = path.join(this.#tempDir, `${basename}.part`);
    const finalPath = path.join(this.#tempDir, `${basename}.wav`);
    this.#ownedTempFiles.add(temporaryPath);
    let handle;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(wav);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporaryPath, finalPath);
      this.#ownedTempFiles.delete(temporaryPath);
      this.#ownedTempFiles.add(finalPath);
      return finalPath;
    } catch (error) {
      await handle?.close();
      await fs.rm(temporaryPath, {force: true});
      this.#ownedTempFiles.delete(temporaryPath);
      throw error;
    }
  }

  async #transcribe(device, segment, wavPath) {
    try {
      this.#cases.beginTranscription(segment.segmentId);
      const transcript = await this.#asr.transcribe(wavPath, {
        caseId: segment.caseId,
        segmentId: segment.segmentId
      });
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
      try {
        this.#cases.failSegment(segment.segmentId, 'Transcription failed');
      } catch {}
      this.#broadcastError(device, 'transcription_failed', true, 'Recording transcription failed', segment.caseId, segment.segmentId);
      this.#logger.error?.('Gateway transcription failed', {caseId: segment.caseId, segmentId: segment.segmentId, errorName: error?.name ?? 'Error'});
    } finally {
      await fs.rm(wavPath, {force: true}).catch(() => {});
      this.#ownedTempFiles.delete(wavPath);
    }
  }

  #requestMediation(connection, message) {
    const device = connection.device;
    const ack = {v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true};
    device.acks.set(message.messageId, ack);
    this.#sendJson(connection, ack);
    this.#enqueue(device, () => this.#mediate(device, message.caseId));
  }

  async #mediate(device, caseId) {
    let snapshot;
    try {
      snapshot = this.#cases.snapshot(caseId);
    } catch {
      this.#broadcastError(device, 'case_not_found', false, 'Case does not exist', caseId);
      return;
    }
    if (snapshot.deviceId !== device.deviceId || !snapshot.canMediate) {
      this.#broadcastError(device, 'mediation_not_ready', true, 'Both A and B need saved transcripts', caseId);
      return;
    }

    this.#broadcastState(device, 'mediating', caseId);
    try {
      const sessionId = await this.#mediatorSession(device, caseId);
      const result = await this.#mediator.mediate(snapshot, sessionId);
      if (!validateMediatorResult(result)) {
        throw new Error('mediation result failed canonical validation');
      }
      const pcm = await this.#tts.synthesize(result.spokenText);
      if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) throw new Error('TTS returned invalid PCM');
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
      this.#broadcastError(device, 'mediation_failed', true, 'Mediation or speech synthesis failed', caseId);
      this.#logger.error?.('Gateway mediation failed', {caseId, errorName: error?.name ?? 'Error'});
    }
  }

  async #mediatorSession(device, caseId) {
    let pending = device.mediatorSessions.get(caseId);
    if (!pending) {
      pending = Promise.resolve(this.#createMediatorSession(caseId));
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

  #enqueue(device, operation) {
    const work = device.queue.catch(() => {}).then(operation);
    device.queue = work;
    this.#activeWork.add(work);
    void work.finally(() => this.#activeWork.delete(work));
    return work;
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
    if (connection.ws.readyState !== WebSocket.OPEN) return;
    connection.ws.send(JSON.stringify(message));
    this.#applyBackpressure(connection);
  }

  #broadcastJson(device, message) {
    for (const connection of device.sockets) this.#sendJson(connection, message);
  }

  #broadcastBinary(device, payload) {
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
  return left.caseId === right.caseId && left.segmentId === right.segmentId && left.speaker === right.speaker &&
    left.audio.sampleRate === right.audio.sampleRate && left.audio.bits === right.audio.bits && left.audio.channels === right.audio.channels;
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
