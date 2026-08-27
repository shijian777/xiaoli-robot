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
import {WindowsTts} from './tts/windows-tts.mjs';

export async function startBridge({
  config = loadConfig(process.env),
  logger = createLogger(),
  client,
  asrService,
  mediatorService,
  ttsService,
  bonjourFactory = () => new Bonjour(),
  gatewayOptions = {}
} = {}) {
  const tempDir = path.resolve(config.tempDir);
  const agentClient = client ?? new AgentStackClient({
    baseUrl: config.baseUrl,
    uak: config.uak,
    projectId: config.projectId
  });
  const whisper = new WhisperService({pythonBin: config.pythonBin, whisperModel: config.whisperModel});
  const asr = asrService ?? new AsrService({
    client: agentClient,
    asrAgentId: config.asrAgentId,
    tempDir,
    whisper
  });
  const mediator = mediatorService ?? new MediatorService({client: agentClient});
  const tts = ttsService ?? new WindowsTts();
  const gateway = createDeviceGateway({
    deviceToken: config.deviceToken,
    tempDir,
    asrService: asr,
    mediatorService: mediator,
    ttsService: tts,
    createMediatorSession: (_caseId, {signal} = {}) => agentClient.createSession(config.mediatorAgentId, {signal}),
    logger,
    ...gatewayOptions
  });

  let bonjour;
  let advertisement;
  try {
    await gateway.listen({host: config.host, port: config.port});
    const address = gateway.address();
    bonjour = bonjourFactory();
    advertisement = bonjour.publish({
      name: '小理本机 Bridge',
      type: 'xiaoli',
      protocol: 'tcp',
      port: address.port,
      txt: {protocol: '1'}
    });
    logger.info?.({event: 'bridge.listening', host: config.host, port: address.port});
  } catch (error) {
    await gateway.shutdown().catch(() => {});
    destroyBonjour(bonjour);
    throw error;
  }

  let shutdownPromise;
  return {
    gateway,
    address: gateway.address(),
    shutdown() {
      shutdownPromise ??= (async () => {
        const gatewayShutdown = gateway.shutdown({graceMs: 5_000});
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

async function main() {
  const runtime = await startBridge();
  let stopping = false;
  process.once('SIGINT', () => {
    if (stopping) return;
    stopping = true;
    const forcedExit = setTimeout(() => process.exit(1), 6_000);
    forcedExit.unref?.();
    void runtime.shutdown().then(
      () => {
        clearTimeout(forcedExit);
        process.exit(0);
      },
      () => process.exit(1)
    );
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const logger = createLogger();
    logger.error({event: 'bridge.start_failed', errorName: error?.name ?? 'Error'});
    process.exitCode = 1;
  });
}
