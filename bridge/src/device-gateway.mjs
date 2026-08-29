import {createHash, timingSafeEqual, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {WebSocket, WebSocketServer} from 'ws';
import {pcmToWav, parsePcmWav} from './audio/wav.mjs';
import {CaseManager, MAX_PCM_BYTES_PER_SEGMENT, MAX_SEGMENTS_PER_CASE} from './case-manager.mjs';
import {decodeBinaryFrame, encodeBinaryFrame, FrameKind} from './protocol/binary-frame.mjs';
import {validateDeviceMessage, validateMediatorResult} from './protocol/schemas.mjs';
import {assertProtocolIdentifier} from './protocol/limits.mjs';
import {AtomicJsonStateStore, syncDirectory} from './persistence/atomic-json-state-store.mjs';

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
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const TEMP_CLEANUP_RETRY_MS = 50;
const TEMP_CLEANUP_ATTEMPTS = 3;
const PERSISTENCE_VERSION = 1;
const MAX_ACKS_PER_DEVICE = 512;
const MAX_RETAINED_DEVICES = 128;
const SEGMENT_ARTIFACT_PATTERN = /^segment-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:part|wav)$/i;
const SEGMENT_WAV_PATTERN = /^segment-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav$/i;

export function createDeviceGateway(options = {}) {
  return new DeviceGateway(options);
}

class DeviceGateway {
  #deviceToken;
  #tempDir;
  #stateDir;
  #stateStore;
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
  #recovered = false;
  #stateWriteDisabled = false;
  #onFatal;
  #fatalReported = false;
  #stateTransactionTail = Promise.resolve();
  #httpHandler;
  #httpRequestTimeoutMs;
  #httpHeadersTimeoutMs;
  #httpKeepAliveTimeoutMs;

  constructor({
    deviceToken,
    tempDir,
    stateDir,
    stateStore,
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
    httpRequestTimeoutMs = DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
    httpHeadersTimeoutMs = DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
    httpKeepAliveTimeoutMs = DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS,
    fileSystem = fs,
    httpHandler = async () => false,
    onFatal = () => {}
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
    assertPositiveFinite(httpRequestTimeoutMs, 'httpRequestTimeoutMs');
    assertPositiveFinite(httpHeadersTimeoutMs, 'httpHeadersTimeoutMs');
    assertPositiveFinite(httpKeepAliveTimeoutMs, 'httpKeepAliveTimeoutMs');
    if (typeof onFatal !== 'function') throw new TypeError('onFatal must be a function');
    if (typeof httpHandler !== 'function') throw new TypeError('httpHandler must be a function');
    for (const method of ['lstat', 'mkdir', 'open', 'readFile', 'readdir', 'rename', 'rm']) {
      if (typeof fileSystem?.[method] !== 'function') throw new TypeError(`fileSystem must provide ${method}()`);
    }

    this.#deviceToken = deviceToken;
    this.#tempDir = path.resolve(tempDir);
    this.#stateDir = path.resolve(stateDir ?? path.join(this.#tempDir, 'state'));
    this.#stateStore = stateStore ?? new AtomicJsonStateStore({
      stateDir: this.#stateDir,
      fileSystem
    });
    for (const method of ['cleanupParts', 'commit', 'load']) {
      if (typeof this.#stateStore?.[method] !== 'function') {
        throw new TypeError(`stateStore must provide ${method}()`);
      }
    }
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
    this.#httpHandler = httpHandler;
    this.#httpRequestTimeoutMs = httpRequestTimeoutMs;
    this.#httpHeadersTimeoutMs = httpHeadersTimeoutMs;
    this.#httpKeepAliveTimeoutMs = httpKeepAliveTimeoutMs;
    this.#onFatal = onFatal;
  }

  async listen({host = '127.0.0.1', port = 0} = {}) {
    if (this.#listening) throw new Error('device gateway is already listening');
    if (this.#stopping) throw new Error('device gateway is stopping');
    await this.#fs.mkdir(this.#tempDir, {recursive: true});
    await this.#recoverOnce();

    this.#server = createServer((request, response) => {
      let pathname;
      try {
        pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      } catch {
        pathname = '';
      }
      if (request.method === 'GET' && pathname === '/healthz') {
        response.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
        response.end(JSON.stringify({status: 'ok'}));
        return;
      }
      const work = Promise.resolve()
        .then(() => this.#httpHandler(request, response))
        .then((handled) => {
          if (handled || response.writableEnded) return;
          response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
          response.end('Not found');
        })
        .catch((error) => {
          this.#logger.error?.('Gateway HTTP handler failed', {
            errorName: error?.name ?? 'Error'
          });
          if (response.writableEnded) return;
          if (response.headersSent) {
            response.destroy();
            return;
          }
          const payload = JSON.stringify({error: 'internal_error'});
          response.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff'
          });
          response.end(payload);
        });
      this.#trackWork(work);
    });
    this.#server.requestTimeout = this.#httpRequestTimeoutMs;
    this.#server.headersTimeout = Math.min(this.#httpHeadersTimeoutMs, this.#httpRequestTimeoutMs);
    this.#server.keepAliveTimeout = this.#httpKeepAliveTimeoutMs;
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

  mobileSnapshot() {
    const devices = [...this.#devices.values()]
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
      .map((device) => {
        let caseSnapshot = null;
        if (device.currentCaseId) {
          try {
            const snapshot = this.#cases.snapshot(device.currentCaseId);
            caseSnapshot = mobileCaseSnapshot(snapshot);
          } catch {
            caseSnapshot = null;
          }
        }
        return {
          deviceId: device.deviceId,
          online: [...device.sockets].some((connection) => this.#isCurrentConnection(connection)),
          firmwareVersion: device.firmwareVersion,
          lastSeenAt: device.lastTouchedAt,
          state: mobileDeviceState(device),
          currentCaseId: device.currentCaseId,
          case: caseSnapshot
        };
      });
    return {devices};
  }

  async requestMobileMediation(deviceId) {
    assertProtocolIdentifier(deviceId, 'deviceId');
    const device = this.#devices.get(deviceId);
    if (!device) throw controlPlaneError('device_not_found');
    const connection = [...device.sockets].find((candidate) => this.#isCurrentConnection(candidate));
    if (!connection || this.#stopping) throw controlPlaneError('device_offline');
    const caseId = device.currentCaseId;
    let snapshot;
    try {
      snapshot = caseId ? this.#cases.snapshot(caseId) : null;
    } catch {
      snapshot = null;
    }
    if (!snapshot?.canMediate || snapshot.deviceId !== deviceId) {
      throw controlPlaneError('mediation_not_ready');
    }

    const messageId = `mobile-mediate-${randomUUID()}`;
    const message = {v: 1, type: 'mediate.request', messageId, caseId};
    clearTimeout(device.pendingMediationTimer);
    device.pendingMediationTimer = undefined;
    let mediationGeneration;
    let resumePreviousPending = false;
    let acceptedMessageId = messageId;
    let reusedPending = false;
    try {
      await this.#withStateTransaction(async () => {
        if (!this.#isCurrentConnection(connection)) throw controlPlaneError('device_offline');
        let currentSnapshot;
        try {
          currentSnapshot = device.currentCaseId === caseId
            ? this.#cases.snapshot(caseId)
            : null;
        } catch {
          currentSnapshot = null;
        }
        if (!currentSnapshot?.canMediate || currentSnapshot.deviceId !== deviceId) {
          throw controlPlaneError('mediation_not_ready');
        }
        if (device.pendingMediation?.caseId === caseId &&
            device.pendingMediation.terminalFailure !== true) {
          acceptedMessageId = device.pendingMediation.messageId;
          reusedPending = true;
          return;
        }

        const ack = {v: 1, type: 'ack', messageId, caseId, accepted: true};
        this.#storeAck(device, message, ack);
        this.#markAckPersistent(device, messageId);
        const previousPending = device.pendingMediation;
        mediationGeneration = this.#supersedeMediation(
          device, 'Mediation request superseded by mobile control');
        device.pendingMediation = {messageId, caseId, deliveryReady: false};
        try {
          await this.#persistState();
        } catch (error) {
          if (isPostRenameCommitFailure(error)) {
            this.#haltForPersistenceFailure(
              'mobile mediation admission after rename', device, error, {caseId});
            throw error;
          }
          device.pendingMediation = previousPending;
          this.#deleteAck(device, messageId);
          resumePreviousPending = Boolean(previousPending);
          throw error;
        }
      });
    } catch (error) {
      if (resumePreviousPending) this.#schedulePendingMediationResume(device, connection);
      throw error;
    }

    if (reusedPending) {
      this.#schedulePendingMediationResume(device, connection);
      return {requestId: acceptedMessageId, caseId};
    }

    if (this.#isCurrentConnection(connection)) {
      this.#startMediation(
        device, caseId, connection.deviceGeneration, messageId,
        mediationGeneration);
    }
    return {requestId: acceptedMessageId, caseId};
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
      this.#server?.closeAllConnections?.();
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
    if (this.#recovered && !this.#stateWriteDisabled) {
      this.#makePreDurableRecordingsReplayable();
      await this.#persistState();
      await this.#removeUnreferencedOwnedTempFiles();
    }
  }

  #makePreDurableRecordingsReplayable() {
    for (const device of this.#devices.values()) {
      const incomplete = new Map();
      for (const [segmentId, progress] of device.segmentProgress) {
        incomplete.set(segmentId, progress.meta);
      }
      for (const [segmentId, commit] of device.segmentCommits) {
        if (!device.segmentJobs.has(segmentId)) incomplete.set(segmentId, commit.meta);
      }
      for (const [segmentId, meta] of incomplete) {
        if (device.segmentJobs.has(segmentId)) continue;
        this.#failAndForgetRecording(
          device, {meta}, 'Recording was interrupted before durable completion', true);
        if (device.activeRecording?.meta?.segmentId === segmentId) {
          device.activeRecording = null;
        }
      }
    }
  }

  async #removeUnreferencedOwnedTempFiles() {
    const referenced = this.#referencedAudioPaths();
    const candidates = [...this.#ownedTempFiles].filter((candidate) => !referenced.has(candidate));
    const removed = await Promise.all(candidates.map((candidate) => this.#tryRemoveOwnedTemp(candidate)));
    if (removed.some((success) => !success)) throw new Error('Bridge could not remove every owned temporary artifact');
  }

  async #recoverOnce() {
    if (this.#recovered) return;
    await this.#stateStore.cleanupParts();
    const state = await this.#stateStore.load();
    if (state !== null) this.#restorePersistentState(state);
    await this.#cleanupStartupArtifacts();
    this.#recovered = true;
    for (const device of this.#devices.values()) {
      for (const job of device.segmentJobs.values()) {
        if (job.status !== 'queued' && job.status !== 'transcribing') continue;
        const segment = this.#cases.segments.get(job.meta.segmentId);
        if (!segment || !job.audioFile) continue;
        const wavPath = path.join(this.#tempDir, job.audioFile);
        this.#enqueue(device, (signal) => this.#transcribe(device, segmentBinding(segment), wavPath, signal), job.meta.caseId);
      }
    }
  }

  #restorePersistentState(state) {
    if (!state || typeof state !== 'object' || state.version !== PERSISTENCE_VERSION ||
        !state.caseManager || !Array.isArray(state.devices) || state.devices.length > MAX_RETAINED_DEVICES) {
      throw new Error('Bridge persistent state is invalid');
    }
    const restoredCases = new CaseManager();
    restoredCases.restoreState(state.caseManager);
    const devices = new Map();
    for (const candidate of state.devices) {
      assertProtocolIdentifier(candidate?.deviceId, 'persistent deviceId');
      if (devices.has(candidate.deviceId) || !Array.isArray(candidate.acks) ||
          !Array.isArray(candidate.segmentAcks) || !Array.isArray(candidate.segmentJobs) ||
          candidate.acks.length > MAX_ACKS_PER_DEVICE ||
          candidate.segmentAcks.length > MAX_SEGMENTS_PER_CASE ||
          candidate.segmentJobs.length > MAX_SEGMENTS_PER_CASE) {
        throw new Error('Bridge persistent device state is invalid');
      }
      const currentCaseId = restoredCases.currentCaseId(candidate.deviceId) ?? null;
      if ((candidate.currentCaseId ?? null) !== currentCaseId) {
        throw new Error('Bridge persistent device current case is invalid');
      }
      const device = createDeviceRecord(candidate.deviceId, currentCaseId);
      device.lastTouchedAt = Number.isFinite(candidate.lastTouchedAt) ? candidate.lastTouchedAt : 0;
      for (const record of candidate.acks) {
        assertProtocolIdentifier(record?.messageId, 'persistent messageId');
        validatePersistentAckIdentifiers(record?.ack);
        if (!record.ack || typeof record.ack !== 'object' ||
            typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(record.fingerprint) ||
            record.ack.messageId !== record.messageId || device.acks.has(record.messageId)) {
          throw new Error('Bridge persistent ACK ledger is invalid');
        }
        device.acks.set(record.messageId, structuredClone(record.ack));
        device.messageFingerprints.set(record.messageId, record.fingerprint);
        device.persistentAckIds.add(record.messageId);
        if (record.binding !== null && record.binding !== undefined) {
          device.ackBindings.set(record.messageId, segmentBinding(record.binding));
        }
      }
      for (const record of candidate.segmentAcks) {
        const meta = segmentBinding(record?.meta);
        if (meta.segmentId !== record.segmentId || !record.ack || typeof record.ack !== 'object' ||
            device.segmentAcks.has(record.segmentId)) {
          throw new Error('Bridge persistent segment ACK is invalid');
        }
        const segment = restoredCases.segments.get(meta.segmentId);
        const ledgerAck = device.acks.get(record.ack.messageId);
        if (!segment || segment.caseId !== currentCaseId || !sameSegmentMeta(segment, meta) ||
            record.ack.type !== 'ack' || record.ack.durable !== true ||
            record.ack.caseId !== meta.caseId || record.ack.segmentId !== meta.segmentId ||
            !Number.isSafeInteger(record.ack.bytes) || record.ack.bytes < 0 ||
            record.ack.bytes > MAX_PCM_BYTES_PER_SEGMENT ||
            !ledgerAck || messageFingerprint(ledgerAck) !== messageFingerprint(record.ack)) {
          throw new Error('Bridge persistent segment ACK binding is invalid');
        }
        device.segmentAcks.set(record.segmentId, {ack: structuredClone(record.ack), meta});
      }
      for (const record of candidate.segmentJobs) {
        const meta = segmentBinding(record?.meta);
        if (device.segmentJobs.has(meta.segmentId) ||
            !['queued', 'transcribing', 'saved', 'failed'].includes(record.status) ||
            !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
            record.bytes > MAX_PCM_BYTES_PER_SEGMENT ||
            (record.audioFile !== null && !SEGMENT_WAV_PATTERN.test(record.audioFile)) ||
            typeof record.notificationPending !== 'boolean') {
          throw new Error('Bridge persistent transcription job is invalid');
        }
        const segment = restoredCases.segments.get(meta.segmentId);
        if (!segment || !sameSegmentMeta(segment, meta) || segment.caseId !== currentCaseId ||
            segment.state !== record.status || !device.segmentAcks.has(meta.segmentId) ||
            device.segmentAcks.get(meta.segmentId).ack.bytes !== record.bytes ||
            (record.status === 'saved' || record.status === 'failed'
              ? record.notificationPending !== true
              : record.notificationPending !== false || record.audioFile === null)) {
          throw new Error('Bridge persistent transcription job binding is invalid');
        }
        device.segmentJobs.set(meta.segmentId, {
          meta,
          audioFile: record.audioFile,
          bytes: record.bytes,
          status: record.status,
          notificationPending: record.notificationPending
        });
      }
      const pendingMediation = candidate.pendingMediation ?? null;
      if (pendingMediation !== null) {
        assertProtocolIdentifier(pendingMediation?.messageId, 'persistent mediation messageId');
        assertProtocolIdentifier(pendingMediation?.caseId, 'persistent mediation caseId');
        if (pendingMediation.deliveryReady !== undefined &&
            typeof pendingMediation.deliveryReady !== 'boolean') {
          throw new Error('Bridge persistent mediation delivery state is invalid');
        }
        if (pendingMediation.terminalFailure !== undefined &&
            typeof pendingMediation.terminalFailure !== 'boolean') {
          throw new Error('Bridge persistent mediation failure state is invalid');
        }
        if (pendingMediation.notificationPending !== undefined &&
            typeof pendingMediation.notificationPending !== 'boolean') {
          throw new Error('Bridge persistent mediation notification state is invalid');
        }
        if (pendingMediation.notificationPending === true &&
            pendingMediation.terminalFailure !== true) {
          throw new Error('Bridge persistent mediation notification binding is invalid');
        }
        const ack = device.acks.get(pendingMediation.messageId);
        if (pendingMediation.caseId !== currentCaseId || ack?.type !== 'ack' ||
            ack.messageId !== pendingMediation.messageId || ack.caseId !== pendingMediation.caseId) {
          throw new Error('Bridge persistent mediation job is invalid');
        }
        device.pendingMediation = {
          messageId: pendingMediation.messageId,
          caseId: pendingMediation.caseId,
          deliveryReady: pendingMediation.deliveryReady === true
        };
        if (pendingMediation.terminalFailure === true) {
          device.pendingMediation.terminalFailure = true;
          // Additive v1 compatibility: terminal states written before this
          // field existed still owe the device its stable failure outcome.
          device.pendingMediation.notificationPending =
            pendingMediation.notificationPending !== false;
        }
      }
      devices.set(device.deviceId, device);
    }
    this.#cases.restoreState(state.caseManager);
    this.#devices = devices;
  }

  async #cleanupStartupArtifacts() {
    const referencedNames = new Set();
    for (const device of this.#devices.values()) {
      for (const job of device.segmentJobs.values()) {
        if (job.audioFile) referencedNames.add(job.audioFile);
      }
    }
    const entries = await this.#fs.readdir(this.#tempDir, {withFileTypes: true});
    await Promise.all(entries.filter((entry) =>
      entry.isFile() && !entry.isSymbolicLink() && SEGMENT_ARTIFACT_PATTERN.test(entry.name) &&
      (entry.name.endsWith('.part') || !referencedNames.has(entry.name))
    ).map((entry) => this.#fs.rm(path.join(this.#tempDir, entry.name), {force: true})));

    let changed = false;
    for (const device of this.#devices.values()) {
      for (const [segmentId, job] of [...device.segmentJobs]) {
        if (!job.audioFile) continue;
        const wavPath = path.join(this.#tempDir, job.audioFile);
        let stats;
        try {
          stats = await this.#fs.lstat(wavPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (stats?.isSymbolicLink() || (stats && !stats.isFile())) {
          throw new Error('Bridge persistent WAV is not a regular file');
        }
        if (!stats) {
          if (job.status === 'saved' || job.status === 'failed') {
            job.audioFile = null;
          } else {
            this.#cases.failSegment(segmentId, 'Durable recording was missing during recovery');
            this.#discardSegmentLedger(device, segmentId);
          }
          changed = true;
          continue;
        }
        this.#ownTemp(wavPath, job.meta.caseId);
        if (job.status === 'saved' || job.status === 'failed') {
          if (await this.#tryRemoveOwnedTemp(wavPath)) {
            job.audioFile = null;
            changed = true;
          }
        }
      }
    }
    if (changed) await this.#persistState();
  }

  #persistentState() {
    return {
      version: PERSISTENCE_VERSION,
      caseManager: this.#cases.exportState(),
      devices: [...this.#devices.values()].map((device) => ({
        deviceId: device.deviceId,
        currentCaseId: device.currentCaseId,
        lastTouchedAt: device.lastTouchedAt,
        acks: [...device.persistentAckIds].map((messageId) => ({
          messageId,
          ack: structuredClone(device.acks.get(messageId)),
          fingerprint: device.messageFingerprints.get(messageId),
          binding: device.ackBindings.has(messageId)
            ? segmentBinding(device.ackBindings.get(messageId))
            : null
        })),
        segmentAcks: [...device.segmentAcks].map(([segmentId, record]) => ({
          segmentId,
          ack: structuredClone(record.ack),
          meta: segmentBinding(record.meta)
        })),
        segmentJobs: [...device.segmentJobs.values()].map((job) => ({
          meta: segmentBinding(job.meta),
          audioFile: job.audioFile,
          bytes: job.bytes,
          status: job.status,
          notificationPending: job.notificationPending
        })),
        pendingMediation: device.pendingMediation ? {...device.pendingMediation} : null
      }))
    };
  }

  #persistState() {
    return this.#stateStore.commit(this.#persistentState());
  }

  #withStateTransaction(operation) {
    const run = this.#stateTransactionTail
      .catch(() => {})
      .then(() => {
        if (this.#stopping || this.#stateWriteDisabled) throw abortError();
        return operation();
      });
    this.#stateTransactionTail = run.catch(() => {});
    return run;
  }

  #referencedAudioPaths() {
    const referenced = new Set();
    for (const device of this.#devices.values()) {
      for (const job of device.segmentJobs.values()) {
        if (job.audioFile) referenced.add(path.join(this.#tempDir, job.audioFile));
      }
    }
    return referenced;
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
      await this.#authenticate(connection, hello);
      return;
    }

    if (!this.#isCurrentConnection(connection)) {
      connection.ws.close(4004, 'device connection superseded');
      return;
    }

    if (isBinary) await this.#routeBinary(connection, data);
    else await this.#routeControl(connection, parseJson(data));
  }

  async #authenticate(connection, hello) {
    await this.#withStateTransaction(async () => {
      clearTimeout(connection.helloTimer);
      let device = this.#devices.get(hello.deviceId);
      if (!device) {
        this.#pruneDisconnectedDevices();
        if (this.#devices.size >= MAX_RETAINED_DEVICES) {
          connection.ws.close(1013, 'device capacity reached');
          return;
        }
        device = createDeviceRecord(
          hello.deviceId,
          this.#cases.currentCaseId(hello.deviceId) ?? null
        );
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
      device.lastTouchedAt = Date.now();
      device.firmwareVersion = hello.firmwareVersion;
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
      this.#markAckPersistent(device, hello.messageId);
      try {
        await this.#persistState();
      } catch (error) {
        if (this.#haltForAmbiguousCommit(
          'hello after rename', device, error,
          {deviceId: hello.deviceId})) return;
        if (!existing) this.#deleteAck(device, hello.messageId);
        this.#logger.error?.('Gateway hello persistence failed', {deviceId: hello.deviceId, errorCode: error?.code ?? 'UNKNOWN'});
        connection.ws.close(1011, 'state persistence failed');
        return;
      }
      this.#sendJson(connection, ack);
      await this.#deliverPendingTranscripts(device);
      this.#schedulePendingMediationResume(device, connection);
    });
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
      if (!this.#replayMessage(connection, message)) await this.#startCase(connection, message);
    }
    else if (message.type === 'mediate.request') await this.#requestMediation(connection, message);
    else if (message.type === 'audio.played') await this.#confirmPlayback(connection, message);
    else this.#sendError(connection, 'invalid_message', false, 'Speech controls must use binary stream frames');
  }

  async #startCase(connection, message) {
    await this.#withStateTransaction(async () => {
      let persistenceAttempted = false;
      const rollbackState = this.#persistentState();
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
        this.#markAckPersistent(connection.device, message.messageId);
        persistenceAttempted = true;
        await this.#persistState();
        this.#sendJson(connection, ack);
        this.#broadcastState(connection.device, 'waiting', message.caseId);
        if (previousCaseId && previousCaseId !== message.caseId) {
          this.#trackWork(this.#removeOwnedTempFilesForCase(previousCaseId));
        }
      } catch (error) {
        if (persistenceAttempted && this.#haltForAmbiguousCommit(
          'case start after rename', connection.device, error,
          {caseId: message.caseId})) return;
        this.#deleteAck(connection.device, message.messageId);
        if (persistenceAttempted) {
          this.#restorePersistentState(rollbackState);
          this.#sendError(connection, 'state_persistence_failed', true, 'Bridge state could not be stored', message.caseId);
          this.#logger.error?.('Gateway case persistence failed', {
            caseId: message.caseId, errorCode: error?.code ?? 'UNKNOWN'
          });
          this.#stateWriteDisabled = true;
          this.#haltForPersistenceFailure('case start', connection.device, error, {caseId: message.caseId});
        } else {
          this.#sendError(connection, 'case_conflict', false, 'Case could not be started');
        }
      }
    });
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
      device.persistentAckIds.delete(messageId);
    }
    for (const [segmentId, record] of device.segmentAcks) {
      if (record.meta.caseId === caseId) device.segmentAcks.delete(segmentId);
    }
    for (const [segmentId, progress] of device.segmentProgress) {
      if (progress.meta.caseId === caseId) device.segmentProgress.delete(segmentId);
    }
    for (const [segmentId, job] of device.segmentJobs) {
      if (job.meta.caseId === caseId) device.segmentJobs.delete(segmentId);
    }
    if (device.pendingMediation?.caseId === caseId) {
      clearTimeout(device.pendingMediationTimer);
      device.pendingMediationTimer = undefined;
      device.pendingMediation = null;
    }
    if (device.activeRecording?.meta?.caseId === caseId) device.activeRecording = null;
    device.mediatorSessions.delete(caseId);
    this.#asr.forgetCase?.(caseId);
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
      this.#logger.error?.('Gateway recording completion mismatch', {
        deviceId: device.deviceId,
        caseId: message.caseId,
        segmentId: message.segmentId,
        caseMatches: message.caseId === meta.caseId,
        segmentMatches: message.segmentId === meta.segmentId,
        complete: message.complete === true,
        endFlag: frame.flags & 1,
        frameSequence: frame.sequence,
        messageLastSequence: message.lastSequence,
        expectedLast,
        receivedBytes: progress.receivedBytes,
        messageBytes: message.bytes
      });
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
    let stateCommitAttempted = false;
    const signal = this.#caseSignal(device, meta.caseId);
    const failCommit = async (error) => {
      if (stateCommitAttempted && this.#haltForAmbiguousCommit(
        'recording completion after rename', device, error,
        {caseId: meta.caseId, segmentId: meta.segmentId})) {
        this.#releaseRecordingOwner(device, recording);
        this.#finishSegmentCommit(device, meta.segmentId, commit);
        return false;
      }
      if (wavPath && !stateCommitAttempted) {
        await this.#tryRemoveOwnedTemp(wavPath);
      }
      if (this.#stopping || signal.aborted) {
        this.#releaseRecordingOwner(device, recording);
        device.segmentProgress.delete(meta.segmentId);
        this.#finishSegmentCommit(device, meta.segmentId, commit);
        return false;
      }
      this.#failAndForgetRecording(device, recording, 'WAV assembly failed', true);
      device.segmentAcks.delete(meta.segmentId);
      device.segmentJobs.delete(meta.segmentId);
      this.#releaseRecordingOwner(device, recording);
      this.#finishSegmentCommit(device, meta.segmentId, commit);
      this.#sendError(connection, 'audio_write_failed', true, 'Recording could not be stored', meta.caseId, meta.segmentId);
      this.#logger.error?.('Gateway WAV write failed', {segmentId: meta.segmentId, errorCode: error?.code ?? 'UNKNOWN'});
      return false;
    };
    try {
      this.#assertRunning(signal);
      completed = this.#cases.copyReceivingAudio(meta.segmentId);
      try {
        wavPath = await this.#writeDurableWav(completed.pcm, completed.audio, meta.caseId, signal);
      } finally {
        completed.pcm.fill(0);
      }
    } catch (error) {
      await this.#withStateTransaction(() => failCommit(error));
      return;
    }
    transcriptionSegment = {
      caseId: completed.caseId,
      segmentId: completed.segmentId,
      speaker: completed.speaker,
      audio: completed.audio
    };
    const stateCommitted = await this.#withStateTransaction(async () => {
      try {
        this.#assertRunning(signal);
        const finalized = this.#cases.endSegment(meta.segmentId);
        try {
          this.#cases.releaseAudio(meta.segmentId);
        } finally {
          finalized.pcm.fill(0);
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
        device.segmentJobs.set(meta.segmentId, {
          meta: segmentBinding(meta),
          audioFile: path.basename(wavPath),
          bytes: progress.receivedBytes,
          status: 'queued',
          notificationPending: false
        });
        for (const [messageId, binding] of device.ackBindings) {
          if (binding?.segmentId === meta.segmentId) this.#markAckPersistent(device, messageId);
        }
        this.#markAckPersistent(device, message.messageId);
        device.segmentProgress.delete(meta.segmentId);
        this.#releaseRecordingOwner(device, recording);
        stateCommitAttempted = true;
        await this.#persistState();
        return true;
      } catch (error) {
        return failCommit(error);
      }
    });
    if (!stateCommitted) return;
    if (this.#stopping || signal.aborted) {
      this.#finishSegmentCommit(device, meta.segmentId, commit);
      return;
    }

    this.#finishSegmentCommit(device, meta.segmentId, commit);
    const ack = device.segmentAcks.get(meta.segmentId).ack;
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

  #releaseRecordingOwner(device, recording) {
    if (device.activeRecording === recording) device.activeRecording = null;
  }

  #failAndForgetRecording(device, recording, failure, force = false) {
    const segmentId = recording?.meta?.segmentId;
    if (!segmentId || recording?.replayAck || (recording?.committing && !force)) return;
    try {
      this.#cases.failSegment(segmentId, failure);
    } catch {
      // The protocol error remains stable even if the segment was terminal.
    }
    this.#discardSegmentLedger(device, segmentId);
  }

  #discardSegmentLedger(device, segmentId) {
    device.segmentProgress.delete(segmentId);
    device.segmentJobs.delete(segmentId);
    device.segmentAcks.delete(segmentId);
    for (const [messageId, binding] of device.ackBindings) {
      if (binding?.segmentId !== segmentId) continue;
      device.acks.delete(messageId);
      device.messageFingerprints.delete(messageId);
      device.ackBindings.delete(messageId);
      device.persistentAckIds.delete(messageId);
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
      await syncDirectory(this.#fs, this.#tempDir);
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
    const job = device.segmentJobs.get(segment.segmentId);
    if (!job) {
      await this.#tryRemoveOwnedTemp(wavPath);
      return;
    }
    try {
      await this.#withStateTransaction(async () => {
        this.#assertRunning(signal);
        this.#cases.beginTranscription(segment.segmentId);
        job.status = 'transcribing';
        await this.#persistState();
      });
    } catch (error) {
      if (this.#stopping || signal?.aborted) return;
      this.#haltForPersistenceFailure('transcription start', device, error, {
        caseId: segment.caseId, segmentId: segment.segmentId
      });
      return;
    }

    let transcript;
    try {
      this.#assertRunning(signal);
      transcript = await this.#asr.transcribe(wavPath, {
        caseId: segment.caseId,
        segmentId: segment.segmentId,
        signal
      });
      this.#assertRunning(signal);
    } catch (error) {
      if (this.#stopping || signal?.aborted) return;
      try {
        await this.#withStateTransaction(async () => {
          this.#cases.failSegment(segment.segmentId, 'Transcription failed');
          job.status = 'failed';
          job.notificationPending = true;
          await this.#persistState();
        });
      } catch (persistenceError) {
        this.#haltForPersistenceFailure('transcription failure', device, persistenceError, {
          caseId: segment.caseId, segmentId: segment.segmentId
        });
        return;
      }
      if (!await this.#cleanupTerminalAudio(
        device, job, wavPath, 'failed transcript WAV cleanup')) return;
      try {
        await this.#deliverPendingTranscripts(device);
      } catch (persistenceError) {
        this.#haltForPersistenceFailure('failed transcript notification', device, persistenceError, {
          caseId: segment.caseId, segmentId: segment.segmentId
        });
        return;
      }
      this.#logger.error?.('Gateway transcription failed', {caseId: segment.caseId, segmentId: segment.segmentId, errorName: error?.name ?? 'Error'});
      return;
    }

    try {
      await this.#withStateTransaction(async () => {
        this.#cases.saveTranscript(segment.segmentId, transcript);
        job.status = 'saved';
        job.notificationPending = true;
        await this.#persistState();
      });
    } catch (error) {
      if (this.#stopping || signal?.aborted) return;
      this.#haltForPersistenceFailure('transcript commit', device, error, {
        caseId: segment.caseId, segmentId: segment.segmentId
      });
      return;
    }

    if (!await this.#cleanupTerminalAudio(
      device, job, wavPath, 'transcript WAV cleanup')) return;
    if (!this.#stopping && !signal.aborted) {
      try {
        await this.#deliverPendingTranscripts(device);
      } catch (error) {
        this.#haltForPersistenceFailure('transcript notification', device, error, {
          caseId: segment.caseId, segmentId: segment.segmentId
        });
      }
    }
  }

  async #cleanupTerminalAudio(device, job, wavPath, action) {
    if (!job.audioFile) return true;
    return this.#withStateTransaction(async () => {
      if (!job.audioFile || !await this.#tryRemoveOwnedTemp(wavPath)) return true;
      job.audioFile = null;
      try {
        await this.#persistState();
        return true;
      } catch (error) {
        this.#haltForPersistenceFailure(action, device, error, {
          caseId: job.meta.caseId,
          segmentId: job.meta.segmentId
        });
        return false;
      }
    });
  }

  async #requestMediation(connection, message) {
    const device = connection.device;
    clearTimeout(device.pendingMediationTimer);
    device.pendingMediationTimer = undefined;
    if (!this.#ownedCase(connection, message.caseId)) return;
    if (this.#replayMessage(connection, message)) {
      if (device.pendingMediation?.messageId === message.messageId &&
          device.pendingMediation.terminalFailure === true) {
        this.#deliverPendingMediationFailure(device);
      } else if (device.pendingMediation?.messageId === message.messageId &&
          !device.mediationWork) {
        this.#startMediation(
          device, message.caseId, connection.deviceGeneration, message.messageId);
      }
      return;
    }
    let mediationGeneration;
    let resumePreviousPending = true;
    const accepted = await this.#withStateTransaction(async () => {
      const ack = {v: 1, type: 'ack', messageId: message.messageId, caseId: message.caseId, accepted: true};
      this.#storeAck(device, message, ack);
      this.#markAckPersistent(device, message.messageId);
      const previousPending = device.pendingMediation;
      mediationGeneration = this.#supersedeMediation(
        device, 'Mediation request superseded');
      device.pendingMediation = {
        messageId: message.messageId,
        caseId: message.caseId,
        deliveryReady: false
      };
      try {
        await this.#persistState();
      } catch (error) {
        if (this.#haltForAmbiguousCommit(
          'mediation admission after rename', device, error,
          {caseId: message.caseId})) {
          resumePreviousPending = false;
          return false;
        }
        device.pendingMediation = previousPending;
        this.#deleteAck(device, message.messageId);
        this.#sendError(connection, 'state_persistence_failed', true, 'Bridge state could not be stored', message.caseId);
        this.#logger.error?.('Gateway mediation persistence failed', {
          caseId: message.caseId, errorCode: error?.code ?? 'UNKNOWN'
        });
        return false;
      }
      this.#sendJson(connection, ack);
      return true;
    });
    if (!accepted) {
      if (resumePreviousPending) {
        this.#schedulePendingMediationResume(device, connection);
      }
      return;
    }
    if (!this.#isCurrentConnection(connection)) return;
    const deliveryGeneration = connection.deviceGeneration;
    this.#startMediation(
      device, message.caseId, deliveryGeneration, message.messageId,
      mediationGeneration);
  }

  async #confirmPlayback(connection, message) {
    const device = connection.device;
    if (this.#replayMessage(connection, message)) return;
    if (!this.#ownedCase(connection, message.caseId)) return;
    await this.#withStateTransaction(async () => {
      if (this.#replayMessage(connection, message)) return;
      const pending = device.pendingMediation;
      if (!pending || pending.caseId !== message.caseId ||
          pending.messageId !== message.mediationMessageId) {
        this.#sendError(connection, 'playback_confirmation_conflict', false,
          'Playback confirmation did not match the pending mediation', message.caseId);
        return;
      }
      if (!pending.deliveryReady) {
        this.#sendError(connection, 'playback_not_ready', true,
          'Playback audio has not completed delivery', message.caseId);
        return;
      }
      clearTimeout(device.pendingMediationTimer);
      device.pendingMediationTimer = undefined;
      const ack = {
        v: 1,
        type: 'ack',
        messageId: message.messageId,
        caseId: message.caseId,
        accepted: true
      };
      this.#storeAck(device, message, ack);
      this.#markAckPersistent(device, message.messageId);
      device.pendingMediation = null;
      try {
        await this.#persistState();
      } catch (error) {
        if (this.#haltForAmbiguousCommit(
          'playback confirmation after rename', device, error,
          {caseId: message.caseId})) return;
        device.pendingMediation = pending;
        this.#deleteAck(device, message.messageId);
        this.#sendError(connection, 'state_persistence_failed', true,
          'Playback confirmation could not be stored', message.caseId);
        this.#haltForPersistenceFailure('playback confirmation', device, error, {
          caseId: message.caseId
        });
        return;
      }
      this.#sendJson(connection, ack);
    });
  }

  #schedulePendingMediationResume(device, connection) {
    clearTimeout(device.pendingMediationTimer);
    device.pendingMediationTimer = undefined;
    if (!device.pendingMediation || device.mediationWork ||
        !this.#isCurrentConnection(connection)) return;
    if (device.pendingMediation.terminalFailure === true) {
      this.#deliverPendingMediationFailure(device);
      return;
    }
    device.pendingMediationTimer = setTimeout(() => {
      device.pendingMediationTimer = undefined;
      if (!device.pendingMediation || device.pendingMediation.terminalFailure === true ||
          device.mediationWork || !this.#isCurrentConnection(connection)) return;
      this.#startMediation(
        device, device.pendingMediation.caseId, connection.deviceGeneration,
        device.pendingMediation.messageId);
    }, 50);
    device.pendingMediationTimer.unref?.();
  }

  #startMediation(
    device, caseId, deliveryGeneration, mediationMessageId,
    reservedMediationGeneration) {
    if (this.#stopping || this.#abortController.signal.aborted) return null;
    const mediationGeneration = reservedMediationGeneration ??
      this.#supersedeMediation(device, 'Mediation request superseded');
    if (device.mediationGeneration !== mediationGeneration || device.mediationWork) return null;
    const controller = new AbortController();
    device.mediationController = controller;
    const lane = Object.freeze({
      caseId,
      deliveryGeneration,
      mediationGeneration,
      mediationMessageId,
      controller
    });
    const signal = AbortSignal.any([
      this.#caseSignal(device, caseId), controller.signal
    ]);
    const work = Promise.resolve()
      .then(() => this.#mediate(device, signal, lane))
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
    device.mediationGeneration += 1;
    const mediationGeneration = device.mediationGeneration;
    device.mediationController?.abort(new Error(reason));
    if (device.mediationWork) this.#activeWork.delete(device.mediationWork);
    device.mediationController = null;
    device.mediationWork = null;
    // A session promise can itself be the non-cooperative provider call. Do
    // not let a stale pending session get reused by the replacement lane.
    device.mediatorSessions.clear();
    return mediationGeneration;
  }

  #mediationCurrent(device, lane) {
    const pending = device.pendingMediation;
    return !this.#stopping && !lane.controller.signal.aborted &&
      device.connectionGeneration === lane.deliveryGeneration &&
      device.mediationGeneration === lane.mediationGeneration &&
      device.mediationController === lane.controller &&
      pending?.caseId === lane.caseId &&
      pending.messageId === lane.mediationMessageId;
  }

  async #mediate(device, signal, lane) {
    const {caseId, mediationMessageId} = lane;
    if (this.#stopping || signal?.aborted ||
        !this.#mediationCurrent(device, lane)) return;
    const readyToRun = await this.#withStateTransaction(async () => {
      if (!this.#mediationCurrent(device, lane)) return false;
      const pending = device.pendingMediation;
      if (!pending || pending.caseId !== caseId || pending.messageId !== mediationMessageId) return false;
      if (pending.terminalFailure === true) return false;
      if (!pending.deliveryReady) return true;
      pending.deliveryReady = false;
      try {
        await this.#persistState();
        return true;
      } catch (error) {
        if (this.#haltForAmbiguousCommit(
          'mediation replay reset after rename', device, error,
          {caseId})) return false;
        pending.deliveryReady = true;
        this.#haltForPersistenceFailure('mediation replay reset', device, error, {caseId});
        return false;
      }
    });
    if (!readyToRun) return;
    let snapshot;
    try {
      snapshot = this.#cases.snapshot(caseId);
    } catch {
      if (this.#mediationCurrent(device, lane)) {
        this.#broadcastError(device, 'case_not_found', false, 'Case does not exist', caseId);
      }
      return;
    }
    if (snapshot.deviceId !== device.deviceId) {
      if (this.#mediationCurrent(device, lane)) {
        this.#broadcastError(device, 'case_forbidden', false, 'Case belongs to another device', caseId);
      }
      return;
    }
    if (!snapshot.canMediate) {
      if (this.#mediationCurrent(device, lane)) {
        this.#broadcastError(device, 'mediation_not_ready', true, 'Both A and B need saved transcripts', caseId);
      }
      return;
    }

    this.#broadcastState(device, 'mediating', caseId);
    let failureStage = 'mediation';
    try {
      const result = await this.#mediateWithSingleRetry(
        device, caseId, snapshot, signal, lane);
      if (!this.#mediationCurrent(device, lane)) return;
      failureStage = 'tts';
      const pcm = await this.#tts.synthesize(result.spokenText, {signal});
      this.#assertRunning(signal);
      if (!this.#mediationCurrent(device, lane)) return;
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
        mediationMessageId,
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
      const deliveryCommitted = await this.#withStateTransaction(async () => {
        if (!this.#mediationCurrent(device, lane)) return false;
        const pending = device.pendingMediation;
        if (!pending || pending.caseId !== caseId || pending.messageId !== mediationMessageId) return false;
        pending.deliveryReady = true;
        try {
          await this.#persistState();
          return true;
        } catch (error) {
          if (this.#haltForAmbiguousCommit(
            'mediation delivery readiness after rename', device, error,
            {caseId})) return false;
          pending.deliveryReady = false;
          this.#haltForPersistenceFailure('mediation delivery readiness', device, error, {caseId});
          return false;
        }
      });
      if (!deliveryCommitted || !this.#mediationCurrent(device, lane)) return;
      this.#broadcastJson(device, {
        v: 1,
        type: 'audio.end',
        caseId,
        mediationMessageId,
        bytes: pcm.length,
        lastSequence: Math.max(0, chunks - 1),
        complete: true
      });
      this.#broadcastState(device, 'waiting', caseId);
    } catch (error) {
      if (this.#stopping || signal?.aborted ||
          !this.#mediationCurrent(device, lane)) return;
      device.mediatorSessions.delete(caseId);
      const failureRecorded = await this.#withStateTransaction(async () => {
        if (!this.#mediationCurrent(device, lane)) return false;
        const pending = device.pendingMediation;
        if (!pending || pending.caseId !== caseId || pending.messageId !== mediationMessageId) {
          return false;
        }
        pending.terminalFailure = true;
        pending.notificationPending = true;
        try {
          await this.#persistState();
          return true;
        } catch (persistError) {
          if (this.#haltForAmbiguousCommit(
            'mediation terminal failure after rename', device, persistError,
            {caseId})) return false;
          delete pending.terminalFailure;
          delete pending.notificationPending;
          this.#haltForPersistenceFailure('mediation terminal failure', device, persistError, {caseId});
          return false;
        }
      });
      if (!failureRecorded) return;
      this.#deliverPendingMediationFailure(device);
      this.#logger.error?.('Gateway mediation failed', {
        caseId,
        failureStage,
        errorName: error?.name ?? 'Error'
      });
    }
  }

  #deliverPendingMediationFailure(device) {
    const pending = device.pendingMediation;
    if (!pending || pending.terminalFailure !== true ||
        pending.notificationPending === false) return;
    this.#broadcastError(
      device, 'mediation_failed', true,
      'Mediation or speech synthesis failed', pending.caseId);
  }

  async #mediateWithSingleRetry(
    device, caseId, snapshot, signal, lane) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!this.#mediationCurrent(device, lane)) throw abortError();
        const sessionId = await this.#mediatorSession(device, caseId, signal);
        this.#assertRunning(signal);
        if (!this.#mediationCurrent(device, lane)) throw abortError();
        const result = await this.#mediator.mediate(snapshot, sessionId, {signal});
        this.#assertRunning(signal);
        if (!this.#mediationCurrent(device, lane)) throw abortError();
        if (!validateMediatorResult(result)) {
          throw new Error('mediation result failed canonical validation');
        }
        return result;
      } catch (error) {
        const current = this.#mediationCurrent(device, lane);
        if (attempt !== 0 || signal?.aborted || this.#stopping || !current) {
          if (attempt !== 0 && current) device.mediatorSessions.delete(caseId);
          throw error;
        }
        device.mediatorSessions.delete(caseId);
        this.#logger.warn?.('Gateway mediation attempt failed; retrying once', {
          caseId,
          attempt: attempt + 1,
          errorName: error?.name ?? 'Error'
        });
      }
    }
    throw new Error('mediation retry exhausted');
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
    device.acks.delete(message.messageId);
    device.messageFingerprints.delete(message.messageId);
    device.ackBindings.delete(message.messageId);
    device.acks.set(message.messageId, ack);
    device.messageFingerprints.set(message.messageId, messageFingerprint(message));
    if (binding) device.ackBindings.set(message.messageId, segmentBinding(binding));
    else device.ackBindings.delete(message.messageId);
    while (device.acks.size > MAX_ACKS_PER_DEVICE) {
      const oldest = [...device.acks.keys()].find((messageId) =>
        !this.#ackHasDurableReference(device, messageId));
      if (oldest === undefined) {
        this.#deleteAck(device, message.messageId);
        throw new Error('Device ACK ledger is full of durable references');
      }
      this.#deleteAck(device, oldest);
    }
  }

  #ackHasDurableReference(device, messageId) {
    if (device.pendingMediation?.messageId === messageId) return true;
    const binding = device.ackBindings.get(messageId);
    if (!binding) return false;
    const segmentId = binding.segmentId;
    return device.segmentProgress.has(segmentId) || device.segmentCommits.has(segmentId) ||
      device.segmentJobs.has(segmentId) || device.segmentAcks.has(segmentId);
  }

  #deleteAck(device, messageId) {
    device.acks.delete(messageId);
    device.messageFingerprints.delete(messageId);
    device.ackBindings.delete(messageId);
    device.persistentAckIds.delete(messageId);
  }

  #markAckPersistent(device, messageId) {
    if (device.acks.has(messageId)) device.persistentAckIds.add(messageId);
  }

  #pruneDisconnectedDevices() {
    if (this.#devices.size < MAX_RETAINED_DEVICES) return;
    const removable = [...this.#devices.values()]
      .filter((device) => device.sockets.size === 0 && !device.currentCaseId &&
        device.segmentJobs.size === 0 && device.segmentCommits.size === 0)
      .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt);
    for (const device of removable) {
      this.#devices.delete(device.deviceId);
      if (this.#devices.size < MAX_RETAINED_DEVICES) break;
    }
  }

  async #deliverPendingTranscripts(device) {
    if (![...device.sockets].some(({ws}) => ws.readyState === WebSocket.OPEN)) return;
    for (const [segmentId, job] of device.segmentJobs) {
      if (!['saved', 'failed'].includes(job.status) || !job.notificationPending) continue;
      if (job.status === 'saved') {
        this.#broadcastJson(device, {
          v: 1,
          type: 'transcript.saved',
          caseId: job.meta.caseId,
          segmentId,
          speaker: job.meta.speaker
        });
      } else {
        this.#broadcastError(device, 'transcription_failed', true,
          'Recording transcription failed', job.meta.caseId, segmentId);
      }
      this.#broadcastState(device, 'waiting', job.meta.caseId, segmentId);
    }
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

  #haltForAmbiguousCommit(context, device, error, fields = {}) {
    if (!isPostRenameCommitFailure(error)) return false;
    this.#haltForPersistenceFailure(context, device, error, fields);
    return true;
  }

  #haltForPersistenceFailure(context, device, error, fields = {}) {
    this.#logger.error?.('Gateway halted after state persistence failure', {
      context,
      deviceId: device?.deviceId,
      errorCode: error?.code ?? 'UNKNOWN',
      ...fields
    });
    for (const connection of device?.sockets ?? []) {
      if (connection.ws.readyState === WebSocket.OPEN || connection.ws.readyState === WebSocket.CONNECTING) {
        connection.ws.close(1011, 'state persistence failed');
      }
    }
    this.#stateWriteDisabled = true;
    if (this.#fatalReported) return;
    this.#fatalReported = true;
    void this.shutdown().then(
      () => this.#reportFatal(error),
      (shutdownError) => {
        this.#logger.error?.('Gateway shutdown after persistence failure did not complete', {
          errorCode: shutdownError?.code ?? 'UNKNOWN'
        });
        this.#reportFatal(new AggregateError(
          [error, shutdownError], 'Gateway persistence failure and shutdown failure'));
      }
    );
  }

  #reportFatal(error) {
    void Promise.resolve().then(() => this.#onFatal(error)).catch((callbackError) => {
      this.#logger.error?.('Gateway fatal callback failed', {
        errorCode: callbackError?.code ?? 'UNKNOWN'
      });
    });
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

function createDeviceRecord(deviceId, currentCaseId = null) {
  return {
    deviceId,
    acks: new Map(),
    messageFingerprints: new Map(),
    ackBindings: new Map(),
    persistentAckIds: new Set(),
    segmentAcks: new Map(),
    segmentJobs: new Map(),
    segmentProgress: new Map(),
    segmentCommits: new Map(),
    activeRecording: null,
    queue: Promise.resolve(),
    mediatorSessions: new Map(),
    mediationGeneration: 0,
    mediationController: null,
    mediationWork: null,
    pendingMediation: null,
    pendingMediationTimer: undefined,
    connectionGeneration: 0,
    currentCaseId,
    caseAbortController: currentCaseId ? new AbortController() : null,
    firmwareVersion: null,
    lastTouchedAt: 0,
    sockets: new Set()
  };
}

function mobileCaseSnapshot(snapshot) {
  const segment = (value) => ({
    segmentId: value.segmentId,
    speaker: value.speaker,
    state: value.state,
    transcript: value.transcript,
    failure: value.failure
  });
  return {
    caseId: snapshot.caseId,
    canMediate: snapshot.canMediate,
    speakers: {
      A: snapshot.speakers.A.map(segment),
      B: snapshot.speakers.B.map(segment)
    }
  };
}

function mobileDeviceState(device) {
  if (device.activeRecording?.meta?.speaker) {
    return `recording_${device.activeRecording.meta.speaker.toLowerCase()}`;
  }
  if (device.mediationWork) return 'mediating';
  if (device.pendingMediation?.terminalFailure) return 'mediation_failed';
  if (device.pendingMediation?.deliveryReady) return 'awaiting_playback';
  if (device.pendingMediation) return 'mediation_queued';
  return device.currentCaseId ? 'waiting' : 'idle';
}

function controlPlaneError(code) {
  return Object.assign(new Error(code), {code});
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
  assertProtocolIdentifier(meta?.caseId, 'caseId');
  assertProtocolIdentifier(meta?.segmentId, 'segmentId');
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
  return createHash('sha256').update(JSON.stringify(sortJson(message))).digest('hex');
}

function validatePersistentAckIdentifiers(ack) {
  if (!ack || typeof ack !== 'object' || ack.v !== 1 ||
      !['ack', 'hello.ack'].includes(ack.type)) {
    throw new Error('Bridge persistent ACK is invalid');
  }
  assertProtocolIdentifier(ack.messageId, 'persistent ACK messageId');
  if (ack.deviceId !== undefined) assertProtocolIdentifier(ack.deviceId, 'persistent ACK deviceId');
  if (ack.caseId !== undefined) assertProtocolIdentifier(ack.caseId, 'persistent ACK caseId');
  if (ack.segmentId !== undefined) assertProtocolIdentifier(ack.segmentId, 'persistent ACK segmentId');
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

function isPostRenameCommitFailure(error) {
  return error?.commitPhase === 'post-rename' && error?.stateMayBeVisible === true;
}

function abortError() {
  const error = new Error('Bridge operation aborted');
  error.name = 'AbortError';
  return error;
}
