import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import Bonjour from 'bonjour-service';
import {AgentStackClient} from './agent-stack/client.mjs';
import {AsrService} from './agent-stack/asr-service.mjs';
import {MediatorService} from './agent-stack/mediator-service.mjs';
import {loadConfig} from './config.mjs';
import {createDeviceGateway} from './device-gateway.mjs';
import {WhisperService} from './fallback/whisper-service.mjs';
import {createLogger} from './logger.mjs';
import {createMobileRuntime} from './mobile/mobile-runtime.mjs';
import {selectTts} from './tts/select-tts.mjs';
import {XfyunRtasrClient} from './xfyun/rtasr-client.mjs';

export async function startBridge({
  config = loadConfig(process.env),
  logger = createLogger(),
  client,
  rtasrClient,
  asrService,
  mediatorService,
  ttsService,
  bonjourFactory = () => new Bonjour(),
  gatewayOptions = {},
  mobileRuntimeFactory = createMobileRuntime,
  mobileOptions = {}
} = {}) {
  const fatalSignal = Promise.withResolvers();
  const {
    onFatal: downstreamOnFatal,
    httpHandler: downstreamHttpHandler,
    ...forwardedGatewayOptions
  } = gatewayOptions;
  if (downstreamOnFatal !== undefined && typeof downstreamOnFatal !== 'function') {
    throw new TypeError('gatewayOptions.onFatal must be a function');
  }
  if (downstreamHttpHandler !== undefined && typeof downstreamHttpHandler !== 'function') {
    throw new TypeError('gatewayOptions.httpHandler must be a function');
  }
  if (typeof mobileRuntimeFactory !== 'function') {
    throw new TypeError('mobileRuntimeFactory must be a function');
  }
  const tempDir = path.resolve(config.tempDir);
  const stateDir = path.resolve(config.stateDir ?? path.join(tempDir, 'state'));
  const agentClient = client ?? new AgentStackClient({
    baseUrl: config.baseUrl,
    uak: config.uak,
    projectId: config.projectId
  });
  let asr = asrService;
  if (!asr) {
    if (rtasrClient || config.xfyunRtasr) {
      const rtasr = rtasrClient ?? new XfyunRtasrClient(config.xfyunRtasr);
      asr = new AsrService({tempDir, rtasr});
    } else {
      const whisper = new WhisperService({pythonBin: config.pythonBin, whisperModel: config.whisperModel});
      asr = new AsrService({
        client: agentClient,
        asrAgentId: config.asrAgentId,
        tempDir,
        whisper
      });
    }
  }
  const mediator = mediatorService ?? new MediatorService({client: agentClient});
  const tts = ttsService ?? selectTts({
    provider: config.ttsProvider,
    xfyun: config.xfyunTts
  });
  let mobileHandler;
  const gateway = createDeviceGateway({
    deviceToken: config.deviceToken,
    tempDir,
    stateDir,
    asrService: asr,
    mediatorService: mediator,
    ttsService: tts,
    createMediatorSession: (_caseId, {signal} = {}) => agentClient.createSession(config.mediatorAgentId, {signal}),
    logger,
    ...forwardedGatewayOptions,
    async httpHandler(request, response) {
      if (mobileHandler && await mobileHandler(request, response)) return true;
      return downstreamHttpHandler ? downstreamHttpHandler(request, response) : false;
    },
    onFatal(error) {
      fatalSignal.resolve(error);
      return downstreamOnFatal?.(error);
    }
  });

  let bonjour;
  let advertisement;
  let mobile = {enabled: false, handler: null};
  try {
    mobile = await mobileRuntimeFactory({
      ...mobileOptions,
      adminToken: config.mobileAdminToken,
      controlPlane: gateway,
      ttsService: tts,
      stateDir
    });
    mobileHandler = mobile.handler;
    await gateway.listen({host: config.host, port: config.port});
    const address = gateway.address();
    if (config.mdnsEnabled !== false) {
      bonjour = bonjourFactory();
      advertisement = bonjour.publish({
        name: '小理本机 Bridge',
        host: 'xiaoli-bridge.local',
        type: 'xiaoli',
        protocol: 'tcp',
        port: address.port,
        txt: {protocol: '1'}
      });
    }
    logger.info?.({event: 'bridge.listening', host: config.host, port: address.port});
    if (mobile.enabled) logger.info?.({event: 'bridge.mobile_enabled'});
  } catch (error) {
    await gateway.shutdown().catch(() => {});
    destroyBonjour(bonjour);
    throw error;
  }

  let shutdownPromise;
  return {
    gateway,
    mobile,
    address: gateway.address(),
    fatal: fatalSignal.promise,
    shutdown() {
      shutdownPromise ??= (async () => {
        const gatewayShutdown = gateway.shutdown();
        await stopAdvertisement(advertisement);
        destroyBonjour(bonjour);
        await gatewayShutdown;
        logger.info?.({event: 'bridge.stopped'});
      })();
      return shutdownPromise;
    }
  };
}

function stopAdvertisement(service) {
  if (!service || typeof service.stop !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      service.stop(finish);
      const timer = setTimeout(finish, 1_000);
      timer.unref?.();
    } catch {
      finish();
    }
  });
}

function destroyBonjour(bonjour) {
  if (!bonjour || typeof bonjour.destroy !== 'function') return;
  try {
    bonjour.destroy(() => {});
  } catch {
    // Gateway shutdown must continue if mDNS teardown reports an error.
  }
}

export async function runBridgeMain({
  startBridgeFn = startBridge,
  registerGracefulShutdownFn = registerGracefulShutdown
} = {}) {
  const runtime = await startBridgeFn();
  registerGracefulShutdownFn({runtime});
  const fatal = await runtime.fatal;
  throw fatal instanceof Error ? fatal : new Error('Bridge terminated after an internal fatal error');
}

async function main() {
  await runBridgeMain();
}

export function registerGracefulShutdown({
  runtime,
  processRef = process,
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const forcedExit = setTimer(() => exit(1), 6_000);
    forcedExit.unref?.();
    void Promise.resolve().then(() => runtime.shutdown()).then(
      () => {
        clearTimer(forcedExit);
        exit(0);
      },
      () => exit(1)
    );
  };
  processRef.once('SIGINT', shutdown);
  processRef.once('SIGTERM', shutdown);
  return shutdown;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const logger = createLogger();
    logger.error({event: 'bridge.start_failed', errorName: error?.name ?? 'Error'});
    process.exitCode = 1;
  });
}
