import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parsePcmWav} from '../src/audio/wav.mjs';
import {createLogger} from '../src/logger.mjs';
import {startBridge} from '../src/server.mjs';

const SAMPLE_RATE = 16_000;
const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startHardwareMock({
  token,
  host = '0.0.0.0',
  port = 8788,
  tempDir = path.join(bridgeRoot, 'tmp', 'hardware-mock'),
  logger = createLogger(),
  bonjourFactory
} = {}) {
  assertNonEmptyString(token, 'DEVICE_SHARED_TOKEN');
  assertNonEmptyString(host, 'BRIDGE_HOST');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('BRIDGE_PORT must be an integer from 0 to 65535');
  }

  const asrService = {
    async transcribe(wavPath, {caseId, segmentId, signal} = {}) {
      signal?.throwIfAborted();
      const {pcm} = parsePcmWav(await fs.readFile(wavPath));
      const metrics = audioMetrics(pcm);
      if (metrics.samples === 0 || metrics.peak === 0) {
        throw new Error('hardware mock received silent recording audio');
      }
      logger.info?.({
        event: 'hardware_mock.recording_received',
        caseId,
        segmentId,
        bytes: pcm.length,
        peak: metrics.peak,
        rms: metrics.rms
      });
      return `本机联调已收到第 ${segmentOrdinal(segmentId)} 段有效录音`;
    },
    forgetCase() {}
  };

  const mediatorService = {
    async mediate(snapshot, _sessionId, {signal} = {}) {
      signal?.throwIfAborted();
      const aCount = savedCount(snapshot?.speakers?.A);
      const bCount = savedCount(snapshot?.speakers?.B);
      return {
        conflictSummary: '这是本机端到端联调，不对真实矛盾作判断。',
        aPosition: `已收到 A 方 ${aCount} 段有效录音。`,
        bPosition: `已收到 B 方 ${bCount} 段有效录音。`,
        aCanImprove: 'A 方链路已通过本机模拟服务验证。',
        bCanImprove: 'B 方链路已通过本机模拟服务验证。',
        commonGround: '双方录音均已按硬件身份分别保存。',
        suggestions: ['听到提示音后即可确认扬声器下行链路正常。'],
        spokenText: `小理本机联调成功。已收到 A 方 ${aCount} 段和 B 方 ${bCount} 段录音。`
      };
    }
  };

  const ttsPcm = makeAudiblePcm();
  const options = {
    config: {
      baseUrl: 'http://127.0.0.1',
      uak: 'unused-local-mock',
      projectId: 'unused-local-mock',
      asrAgentId: 'unused-local-mock',
      mediatorAgentId: 'unused-local-mock',
      deviceToken: token,
      host,
      port,
      sampleRate: SAMPLE_RATE,
      bits: 16,
      channels: 1,
      pythonBin: 'python',
      whisperModel: 'unused',
      tempDir: path.resolve(tempDir)
    },
    asrService,
    mediatorService,
    ttsService: {async synthesize(_text, {signal} = {}) {
      signal?.throwIfAborted();
      return Buffer.from(ttsPcm);
    }},
    gatewayOptions: {createMediatorSession: async () => 'hardware-mock-session'},
    logger
  };
  if (bonjourFactory) options.bonjourFactory = bonjourFactory;
  return startBridge(options);
}

export function makeAudiblePcm({seconds = 3} = {}) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
    throw new RangeError('seconds must be greater than 0 and at most 30');
  }
  const sampleCount = Math.round(SAMPLE_RATE * seconds);
  const pcm = Buffer.alloc(sampleCount * 2);
  const frequencies = [659.25, 783.99, 987.77];
  const noteSamples = Math.max(1, Math.floor(sampleCount / frequencies.length));
  const rampSamples = Math.floor(SAMPLE_RATE * 0.01);
  for (let index = 0; index < sampleCount; index += 1) {
    const noteIndex = Math.min(frequencies.length - 1, Math.floor(index / noteSamples));
    const withinNote = index - noteIndex * noteSamples;
    const remaining = Math.min(noteSamples, sampleCount - noteIndex * noteSamples) - withinNote;
    const envelope = Math.min(1, withinNote / rampSamples, remaining / rampSamples);
    const sample = Math.round(Math.sin(2 * Math.PI * frequencies[noteIndex] * index / SAMPLE_RATE) * 12_000 * envelope);
    pcm.writeInt16LE(sample, index * 2);
  }
  return pcm;
}

function audioMetrics(pcm) {
  let peak = 0;
  let squares = 0;
  const samples = pcm.length / 2;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    peak = Math.max(peak, Math.abs(value));
    squares += value * value;
  }
  return {samples, peak, rms: samples === 0 ? 0 : Math.round(Math.sqrt(squares / samples))};
}

function savedCount(segments) {
  return Array.isArray(segments)
    ? segments.filter((segment) => segment?.state === 'saved' && segment.transcript?.trim()).length
    : 0;
}

function segmentOrdinal(segmentId) {
  if (typeof segmentId !== 'string') return 1;
  const match = segmentId.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : 1;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function parseMainPort(value) {
  if (!/^\d+$/.test(value ?? '')) throw new Error('BRIDGE_PORT must be an integer from 1 to 65535');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('BRIDGE_PORT must be an integer from 1 to 65535');
  return port;
}

async function main() {
  const logger = createLogger();
  const runtime = await startHardwareMock({
    token: process.env.DEVICE_SHARED_TOKEN,
    host: process.env.BRIDGE_HOST?.trim() || '0.0.0.0',
    port: parseMainPort(process.env.BRIDGE_PORT ?? '8788'),
    tempDir: process.env.BRIDGE_TEMP_DIR?.trim() || path.join(bridgeRoot, 'tmp', 'hardware-mock'),
    logger
  });
  logger.info({event: 'hardware_mock.ready', host: runtime.address.address, port: runtime.address.port});

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.shutdown().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    const logger = createLogger();
    logger.error({event: 'hardware_mock.start_failed', errorName: error?.name ?? 'Error'});
    process.exitCode = 1;
  });
}
