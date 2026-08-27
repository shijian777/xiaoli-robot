# 小理本机 Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个运行在 Windows 本机的 Node.js Bridge，可靠接收 D 板 A/B 音频，调用 TiDB Agent Stack 完成转写与调解，并把 Windows 中文 TTS 的 16 kHz PCM 流回设备。

**Architecture:** Bridge 用 `ws` 提供 `/device` WebSocket，业务控制为 JSON，音频为带 `XL` 固定头的二进制帧。案件与转写队列在本机内存中管理，Agent Stack 使用 UAK、Project、两个 Agent 和每案件 Session；TTS 通过 PowerShell `System.Speech` 完成。

**Tech Stack:** Node.js 24.16.0、ES modules、Node test runner、`ws`、`ajv`、`bonjour-service`、Agent Stack HTTP/NDJSON、PowerShell `System.Speech`、可选 Python 3.11 + `faster-whisper`。

**Spec:** `docs/plans/2026-08-28-xiaoli-wifi-mediation-design.md`

## Global Constraints

- Bridge 必须运行在 Windows 本机，默认监听 `0.0.0.0:8788`。
- 设备 PCM 固定为 16000 Hz、16-bit little-endian、单声道。
- 真实 UAK、登录密码和设备令牌只能从 `.env.local`/进程环境读取；`.env.local` 必须被 Git 忽略。
- 使用轮换后的新 UAK；不得把聊天中暴露过的旧 UAK 写入任何文件或命令输出。
- 普通日志不得打印完整陈述、密码、UAK、设备令牌或 Agent Stack Authorization Header。
- 每个案件必须有独立调解 Session；A/B 身份只信任硬件元数据。
- 原始 WAV 在转写完成或最终失败后删除。
- NDJSON 必须逐行解析；成功条件为 `assistant_message` 加 `turn_finished.payload.status == "succeeded"`。
- 同一 Agent Stack Session 同时只允许一个 active Turn。
- TTS 必须输出 16000 Hz、16-bit、单声道 PCM，不能依赖 ffmpeg。

---

## File Structure

```text
bridge/
├── package.json                         npm scripts and pinned dependencies
├── .env.example                        secret-free configuration contract
├── .gitignore                          ignores .env.local, temp audio and logs
├── requirements-whisper.txt            optional ASR fallback dependency
├── scripts/
│   ├── synthesize.ps1                  System.Speech -> 16 kHz mono WAV
│   ├── transcribe.py                   faster-whisper JSON CLI
│   └── fake-device.mjs                 deterministic WebSocket demo client
├── src/
│   ├── config.mjs                      validated runtime configuration
│   ├── logger.mjs                      redacted structured logging
│   ├── protocol/
│   │   ├── binary-frame.mjs            XL binary envelope codec
│   │   └── schemas.mjs                 JSON/Ajv schemas
│   ├── audio/
│   │   └── wav.mjs                     PCM/WAV encode and decode
│   ├── agent-stack/
│   │   ├── ndjson.mjs                  incremental Turn event parser
│   │   ├── client.mjs                  projects, agents, sessions and turns
│   │   ├── asr-service.mjs             audio Turn + transcript validation
│   │   └── mediator-service.mjs        mediation prompt + response validation
│   ├── fallback/
│   │   └── whisper-service.mjs         bounded child-process fallback
│   ├── tts/
│   │   └── windows-tts.mjs             PowerShell wrapper and WAV validation
│   ├── case-manager.mjs                case/segment lifecycle and idempotency
│   ├── device-gateway.mjs              WebSocket authentication and routing
│   └── server.mjs                      composition root and mDNS lifecycle
└── test/
    ├── config.test.mjs
    ├── binary-frame.test.mjs
    ├── wav.test.mjs
    ├── case-manager.test.mjs
    ├── ndjson.test.mjs
    ├── agent-stack-client.test.mjs
    ├── services.test.mjs
    ├── windows-tts.test.mjs
    └── device-gateway.test.mjs
```

### Task 1: Bridge scaffold, configuration and secret hygiene

**Files:**
- Create: `bridge/package.json`
- Create: `bridge/.env.example`
- Create: `bridge/.gitignore`
- Create: `bridge/src/config.mjs`
- Create: `bridge/src/logger.mjs`
- Create: `bridge/test/config.test.mjs`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): BridgeConfig`
- Produces: `createLogger(sink?): {info, warn, error}` with recursive redaction of keys matching `/key|token|password|authorization/i`

- [ ] **Step 1: Write failing configuration tests**

```js
// bridge/test/config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

const valid = {
  AGENT_STACK_BASE_URL: 'https://ventured-agent-stack.pingcap.cn',
  AGENT_STACK_USER_API_KEY: 'test-uak-not-real',
  AGENT_STACK_PROJECT_ID: 'project_test',
  ASR_AGENT_ID: 'agent_asr',
  MEDIATOR_AGENT_ID: 'agent_mediator',
  DEVICE_SHARED_TOKEN: 'device-test-token'
};

test('loadConfig returns fixed local defaults', () => {
  const cfg = loadConfig(valid);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 8788);
  assert.equal(cfg.sampleRate, 16000);
  assert.equal(cfg.channels, 1);
});

test('loadConfig rejects a missing secret', () => {
  const env = {...valid};
  delete env.AGENT_STACK_USER_API_KEY;
  assert.throws(() => loadConfig(env), /AGENT_STACK_USER_API_KEY/);
});
```

- [ ] **Step 2: Run the test and verify it fails because `config.mjs` does not exist**

Run: `cd bridge; npm test -- --test-name-pattern="loadConfig"`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Add package metadata and exact scripts**

```json
{
  "name": "xiaoli-local-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {"node": ">=24.0.0"},
  "scripts": {
    "test": "node --test",
    "start": "node --env-file=.env.local src/server.mjs",
    "fake-device": "node --env-file=.env.local scripts/fake-device.mjs"
  },
  "dependencies": {
    "ajv": "^8.17.1",
    "bonjour-service": "^1.3.0",
    "ws": "^8.18.3"
  }
}
```

- [ ] **Step 4: Implement strict configuration and redacted logger**

`BridgeConfig` must contain `baseUrl`, `uak`, `projectId`, `asrAgentId`, `mediatorAgentId`, `deviceToken`, `host`, `port`, `sampleRate`, `bits`, `channels`, `pythonBin`, `whisperModel`, and `tempDir`. Strip a trailing slash from `baseUrl`; validate URLs with `new URL()`; parse `BRIDGE_PORT` as integer `1..65535`.

`.env.example` must contain only safe values:

```dotenv
AGENT_STACK_BASE_URL=https://ventured-agent-stack.pingcap.cn
AGENT_STACK_USER_API_KEY=
AGENT_STACK_PROJECT_ID=
ASR_AGENT_ID=
MEDIATOR_AGENT_ID=
DEVICE_SHARED_TOKEN=
BRIDGE_HOST=0.0.0.0
BRIDGE_PORT=8788
PYTHON_BIN=python
WHISPER_MODEL=small
```

`bridge/.gitignore` must contain:

```gitignore
.env.local
tmp/
*.log
__pycache__/
```

- [ ] **Step 5: Install dependencies and run focused tests**

Run: `cd bridge; npm install; npm test -- --test-name-pattern="loadConfig"`
Expected: two PASS results and no secret values in output.

- [ ] **Step 6: Commit the scaffold**

```bash
git add bridge/package.json bridge/package-lock.json bridge/.env.example bridge/.gitignore bridge/src/config.mjs bridge/src/logger.mjs bridge/test/config.test.mjs
git commit -m "feat(bridge): add validated local configuration"
```

### Task 2: Binary audio frame codec and JSON schemas

**Files:**
- Create: `bridge/src/protocol/binary-frame.mjs`
- Create: `bridge/src/protocol/schemas.mjs`
- Create: `bridge/test/binary-frame.test.mjs`

**Interfaces:**
- Produces: `encodeBinaryFrame({kind, streamType, flags, sequence, payload}): Buffer`
- Produces: `decodeBinaryFrame(buffer): BinaryFrame`
- Produces: `validateDeviceMessage(value)` and `validateMediatorResult(value)`

- [ ] **Step 1: Write failing byte-exact codec tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameKind, encodeBinaryFrame, decodeBinaryFrame } from '../src/protocol/binary-frame.mjs';

test('encodes the XL v1 eight-byte header', () => {
  const frame = encodeBinaryFrame({
    kind: FrameKind.STREAM_CHUNK,
    streamType: 2,
    flags: 0,
    sequence: 513,
    payload: Buffer.from([0x11, 0x22])
  });
  assert.deepEqual([...frame], [0x58,0x4c,1,3,2,0,1,2,0x11,0x22]);
  assert.deepEqual(decodeBinaryFrame(frame), {
    version: 1, kind: 3, streamType: 2, flags: 0, sequence: 513,
    payload: Buffer.from([0x11,0x22])
  });
});

test('rejects bad magic and unsupported version', () => {
  assert.throws(() => decodeBinaryFrame(Buffer.from([0,0,1,3,2,0,0,0])), /magic/);
  assert.throws(() => decodeBinaryFrame(Buffer.from([0x58,0x4c,2,3,2,0,0,0])), /version/);
});
```

- [ ] **Step 2: Run the codec tests and verify they fail**

Run: `cd bridge; node --test test/binary-frame.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the codec with fixed constants**

Use `FrameKind = {CONTROL:1, STREAM_START:2, STREAM_CHUNK:3, STREAM_END:4}` and `HEADER_BYTES = 8`. Reject payloads above 65535 bytes, invalid kind, invalid stream type `0..4`, invalid sequence `0..65535`, and frames shorter than eight bytes.

- [ ] **Step 4: Add Ajv schemas**

Require `v:1`, `type`, `messageId`, and type-specific fields. `speech.start` must require `speaker` enum `A|B` and audio exactly `{sampleRate:16000,bits:16,channels:1}`. The mediation schema must require all eight fields from the approved design and at least one non-empty suggestion.

- [ ] **Step 5: Run protocol tests**

Run: `cd bridge; node --test test/binary-frame.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit the protocol contract**

```bash
git add bridge/src/protocol bridge/test/binary-frame.test.mjs
git commit -m "feat(bridge): define device wire protocol"
```

### Task 3: WAV assembly and idempotent case manager

**Files:**
- Create: `bridge/src/audio/wav.mjs`
- Create: `bridge/src/case-manager.mjs`
- Create: `bridge/test/wav.test.mjs`
- Create: `bridge/test/case-manager.test.mjs`

**Interfaces:**
- Produces: `pcmToWav(pcm, {sampleRate,bits,channels}): Buffer`
- Produces: `parsePcmWav(wav): {pcm,sampleRate,bits,channels}`
- Produces: `CaseManager.startCase(deviceId, caseId)`
- Produces: `CaseManager.startSegment(meta)`, `appendChunk(segmentId, sequence, pcm)`, `endSegment(segmentId)`, `saveTranscript(segmentId, transcript)`, `snapshot(caseId)`

- [ ] **Step 1: Write failing WAV header tests**

Create four PCM samples and assert the output starts with `RIFF`, has `WAVE`, `fmt ` and `data`, reports sample rate 16000, byte rate 32000, block align 2, bits 16, and data length 8.

- [ ] **Step 2: Write failing case/idempotency tests**

```js
test('does not duplicate a retried segment or chunk', () => {
  const cases = new CaseManager();
  cases.startCase('device-1', 'case-1');
  const meta = {caseId:'case-1',segmentId:'seg-1',speaker:'A',audio:{sampleRate:16000,bits:16,channels:1}};
  cases.startSegment(meta);
  cases.startSegment(meta);
  cases.appendChunk('seg-1', 0, Buffer.from([1,2]));
  cases.appendChunk('seg-1', 0, Buffer.from([1,2]));
  assert.equal(cases.endSegment('seg-1').pcm.length, 2);
});
```

Also assert that sequence `0,2` throws `missing audio sequence 1`, a reused `segmentId` with a different speaker throws a conflict, and `snapshot()` preserves input order independently for A and B.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd bridge; node --test test/wav.test.mjs test/case-manager.test.mjs`
Expected: FAIL because modules are missing.

- [ ] **Step 4: Implement WAV and case lifecycle**

Use Buffers only; reject odd PCM byte length and any format other than the fixed approved format. `CaseManager` must model segment states `receiving|queued|transcribing|saved|failed`, store chunks in a `Map<number,Buffer>`, and only allow `mediate` when both speakers have at least one non-empty saved transcript and no segment is `receiving|queued|transcribing`.

- [ ] **Step 5: Run the focused tests**

Run: `cd bridge; node --test test/wav.test.mjs test/case-manager.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit audio and case state**

```bash
git add bridge/src/audio/wav.mjs bridge/src/case-manager.mjs bridge/test/wav.test.mjs bridge/test/case-manager.test.mjs
git commit -m "feat(bridge): assemble audio and track mediation cases"
```

### Task 4: Agent Stack client and NDJSON correctness

**Files:**
- Create: `bridge/src/agent-stack/ndjson.mjs`
- Create: `bridge/src/agent-stack/client.mjs`
- Create: `bridge/test/ndjson.test.mjs`
- Create: `bridge/test/agent-stack-client.test.mjs`

**Interfaces:**
- Produces: `readTurnEvents(readable): AsyncGenerator<object>`
- Produces: `AgentStackClient.listProjects()`, `listAgents()`, `createSession(agentId)`, `runTextTurn(sessionId,input)`, `runAudioTurn(sessionId,wav,name)`
- Produces: `TurnResult {assistantMessage, events, status}`

- [ ] **Step 1: Write NDJSON fragmentation tests**

Feed a `ReadableStream` whose chunks split JSON in the middle, include blank heartbeat lines, and end without a trailing newline. Assert all three JSON events are returned in order and blank lines are ignored.

- [ ] **Step 2: Write a local mock HTTP test**

Start `node:http` on an ephemeral loopback port. Assert every project-scoped request includes an `Authorization` header matching the configured test credential and `x-agent9-project-id: project_test`; assert audio uses multipart field name `file`; respond with `assistant_message` and successful `turn_finished` NDJSON.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd bridge; node --test test/ndjson.test.mjs test/agent-stack-client.test.mjs`
Expected: FAIL because client modules do not exist.

- [ ] **Step 4: Implement bounded Agent Stack calls**

Use built-in `fetch`, `FormData`, `Blob` and `AbortSignal.timeout(90000)`. `GET /api/console/projects` and `GET /api/agents` are discovery calls. `POST /api/sessions` sends `{agentId}`. Text Turn sends `{input:{type:'text',text}}`. Audio Turn posts WAV as `audio/wav`. Never include UAK in thrown error text.

Map HTTP 501 from audio Turn to an exported `AsrUnavailableError`; map 409 active-turn conflicts to a non-retryable error; for 429/5xx honor `Retry-After` and perform at most one retry only when the request is protected against duplicate effects.

- [ ] **Step 5: Require successful terminal events**

`run*Turn` must throw unless it observes exactly one final `assistant_message` and a `turn_finished` whose status is `succeeded`. Preserve sanitized `turn_error.code` and `turn_error.message` without request headers.

- [ ] **Step 6: Run client tests**

Run: `cd bridge; node --test test/ndjson.test.mjs test/agent-stack-client.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit the Agent Stack client**

```bash
git add bridge/src/agent-stack/ndjson.mjs bridge/src/agent-stack/client.mjs bridge/test/ndjson.test.mjs bridge/test/agent-stack-client.test.mjs
git commit -m "feat(bridge): add Agent Stack session and turn client"
```

### Task 5: ASR, mediation validation and Whisper fallback

**Files:**
- Create: `bridge/src/agent-stack/asr-service.mjs`
- Create: `bridge/src/agent-stack/mediator-service.mjs`
- Create: `bridge/src/fallback/whisper-service.mjs`
- Create: `bridge/scripts/transcribe.py`
- Create: `bridge/requirements-whisper.txt`
- Create: `bridge/test/services.test.mjs`

**Interfaces:**
- Produces: `AsrService.transcribe(wavPath,{caseId,segmentId}): Promise<string>`; the service always deletes `wavPath` in `finally`
- Produces: `MediatorService.mediate(caseSnapshot,sessionId): Promise<MediationResult>`
- Produces: `WhisperService.transcribe(wavPath): Promise<string>`

- [ ] **Step 1: Write failing service tests**

Use fake Agent Stack clients. Assert ASR accepts only JSON object `{transcript:string,unclear:boolean}`, rejects empty transcript, and invokes Whisper exactly once only for `AsrUnavailableError`. Assert mediator rejects missing fields and `spokenText` above 700 Chinese characters.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd bridge; node --test test/services.test.mjs`
Expected: FAIL because service modules do not exist.

- [ ] **Step 3: Implement transcript extraction**

Strip a single Markdown JSON fence if present, parse once, and validate with Ajv. Do not infer A/B from text. Accept only a Bridge-created WAV path under `tempDir`, call audio Turn, then delete in `finally` using `fs.rm(path,{force:true})`.

- [ ] **Step 4: Implement the exact mediation prompt**

The prompt must include the approved case JSON and these rules verbatim in Chinese: remain neutral; distinguish claims from established facts; identify both sides' needs; do not announce a winner; do not mechanically split blame; stop ordinary mediation for violence, self-harm, abuse or immediate danger; return only the eight-field JSON object; keep `spokenText` suitable for about one minute of playback.

- [ ] **Step 5: Add the deterministic Whisper CLI**

`requirements-whisper.txt`:

```text
faster-whisper==1.2.1
```

`transcribe.py` must load `WhisperModel(model, device="cpu", compute_type="int8")`, call `transcribe(path, language="zh", vad_filter=True)`, join non-empty segment text, and print exactly one JSON line `{"transcript":"..."}`. It must print errors to stderr and exit non-zero without logging audio bytes.

- [ ] **Step 6: Implement bounded fallback invocation**

Spawn the argument array `[scripts/transcribe.py, '--model', 'small', '--input', wavPath]` with `pythonBin`, a 180-second timeout, maximum stdout 1 MiB, and `shell:false`. Kill the child on timeout. Parse its one-line JSON output and reject empty transcripts.

- [ ] **Step 7: Run service tests**

Run: `cd bridge; node --test test/services.test.mjs`
Expected: PASS with the child process mocked; no model download occurs in unit tests.

- [ ] **Step 8: Commit Agent services**

```bash
git add bridge/src/agent-stack/asr-service.mjs bridge/src/agent-stack/mediator-service.mjs bridge/src/fallback/whisper-service.mjs bridge/scripts/transcribe.py bridge/requirements-whisper.txt bridge/test/services.test.mjs
git commit -m "feat(bridge): add transcription and mediation services"
```

### Task 6: Windows Chinese TTS

**Files:**
- Create: `bridge/scripts/synthesize.ps1`
- Create: `bridge/src/tts/windows-tts.mjs`
- Create: `bridge/test/windows-tts.test.mjs`

**Interfaces:**
- Produces: `WindowsTts.synthesize(text): Promise<Buffer>` returning headerless PCM16LE/16k/mono

- [ ] **Step 1: Write a failing real local TTS smoke test**

The test synthesizes `小理开始调解。`, parses the resulting WAV, and asserts sample rate 16000, bits 16, channels 1, PCM length greater than 3200 bytes, and no RIFF header in the service return value.

- [ ] **Step 2: Run and verify the test fails**

Run: `cd bridge; node --test test/windows-tts.test.mjs`
Expected: FAIL because TTS files do not exist.

- [ ] **Step 3: Implement `synthesize.ps1` without ffmpeg**

Use `Add-Type -AssemblyName System.Speech`, select `Microsoft Huihui Desktop` when installed, create `SpeechAudioFormatInfo(16000, Sixteen, Mono)`, call `SetOutputToWaveFile`, `Speak`, and `Dispose`. Accept text and output path as named parameters; reject empty text.

- [ ] **Step 4: Implement the Node wrapper**

Invoke the existing Windows PowerShell executable with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, use an argument array with `shell:false`, enforce a 90-second timeout, parse WAV with `parsePcmWav`, delete the temp WAV in `finally`, and return PCM only.

- [ ] **Step 5: Run TTS tests and audibly inspect one artifact**

Run: `cd bridge; node --test test/windows-tts.test.mjs`
Expected: PASS. The test must delete its temporary WAV; a separate manual smoke may keep one file under `bridge/tmp/manual/` for playback and then remove it.

- [ ] **Step 6: Commit TTS support**

```bash
git add bridge/scripts/synthesize.ps1 bridge/src/tts/windows-tts.mjs bridge/test/windows-tts.test.mjs
git commit -m "feat(bridge): synthesize 16 kHz Chinese speech"
```

### Task 7: Device gateway, orchestration and fake-device vertical slice

**Files:**
- Create: `bridge/src/device-gateway.mjs`
- Create: `bridge/src/server.mjs`
- Create: `bridge/scripts/fake-device.mjs`
- Create: `bridge/test/device-gateway.test.mjs`
- Create: `bridge/README.md`

**Interfaces:**
- Consumes: protocol codec, schemas, CaseManager, ASR, mediator and TTS services
- Produces: authenticated `/device` WebSocket service and `_xiaoli._tcp.local` advertisement

- [ ] **Step 1: Write failing gateway tests**

Start the gateway on loopback and assert: wrong device token closes with code 4003; correct `hello` gets `hello.ack`; duplicate `messageId` gets the same ACK but is applied once; `speech.start/chunk/end` creates one queued segment; missing chunk produces `error.code == "audio_sequence_gap"`; `mediate.request` is rejected until both A and B transcripts exist.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd bridge; node --test test/device-gateway.test.mjs`
Expected: FAIL because gateway files do not exist.

- [ ] **Step 3: Implement authenticated routing and backpressure**

Require `hello` as the first message within five seconds. Keep one active recording stream per device. Pause accepting audio when `ws.bufferedAmount` exceeds 256 KiB and close with 1011 if it remains above the threshold for ten seconds. Send heartbeat ping every ten seconds and terminate after two missed pong intervals.

- [ ] **Step 4: Wire asynchronous segment processing**

On clean `STREAM_END`, assemble and validate WAV, write it atomically under `tempDir`, then ACK the durable local file so firmware may release PSRAM. Call `AsrService.transcribe(wavPath,...)`, update CaseManager, and emit `transcript.saved`; the service deletes the temporary file in `finally`. Maintain a per-device promise queue so ASR requests do not overlap in one Session. Replayed `segmentId` values return the original ACK and never create a second file or transcript.

- [ ] **Step 5: Wire mediation and PCM streaming**

On `mediate.request`, wait for the queue, validate both sides, create/reuse the case mediator Session, call mediator, synthesize `spokenText`, send `audio.start`, emit voice chunks no larger than 4096 bytes with increasing 16-bit sequence, send `audio.end`, then return state `waiting`.

- [ ] **Step 6: Advertise mDNS and implement graceful shutdown**

Advertise service name `小理本机 Bridge`, type `xiaoli`, protocol `tcp`, port 8788, TXT `protocol=1`. On Ctrl+C stop accepting sockets, close Bonjour, wait up to five seconds for active work, close clients with 1001, and delete remaining temp files.

- [ ] **Step 7: Implement the fake device**

The script must generate two deterministic 16 kHz PCM snippets in memory, send an A segment and a B segment with valid sequences, request mediation, save returned PCM to `bridge/tmp/fake-device-result.wav`, and exit only after `audio.end`. It must use `DEVICE_SHARED_TOKEN` from the environment and never print it.

- [ ] **Step 8: Run the complete local test suite**

Run: `cd bridge; npm test`
Expected: all tests PASS; no external Agent Stack request is made by unit tests.

- [ ] **Step 9: Run a mock vertical slice**

Start a local mock Agent Stack server from the test harness, then run Bridge and fake device against it. Expected: one A transcript, one B transcript, one validated mediation result and a valid 16 kHz WAV output.

- [ ] **Step 10: Document startup and commit**

`bridge/README.md` must include Node version, `.env.local` creation from `.env.example`, `npm ci`, `npm test`, `npm start`, Windows Firewall port 8788, Whisper fallback installation, mDNS/manual-IP behavior, privacy behavior and sanitized troubleshooting.

```bash
git add bridge/src/device-gateway.mjs bridge/src/server.mjs bridge/scripts/fake-device.mjs bridge/test/device-gateway.test.mjs bridge/README.md
git commit -m "feat(bridge): complete local mediation gateway"
```

### Task 8: Bridge security and completion gate

**Files:**
- Modify: `bridge/README.md`
- Test: all `bridge/test/*.test.mjs`

**Interfaces:**
- Produces: verified Bridge artifact ready for firmware integration

- [ ] **Step 1: Run all tests from a clean install**

Run: `cd bridge; npm ci; npm test`
Expected: npm restores the lockfile-defined dependency tree and all tests PASS.

- [ ] **Step 2: Scan tracked files for secrets**

Run: `git grep -n -E "ag9_(uak|wak)_[A-Za-z0-9_-]{12,}|Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9_-]{12,}" -- bridge`
Expected: no output and exit code 1.

- [ ] **Step 3: Verify `.env.local` is ignored**

Run: `git check-ignore -v bridge/.env.local`
Expected: matches `bridge/.gitignore`.

- [ ] **Step 4: Review the diff and commit documentation corrections**

Run: `git diff --check`
Expected: no whitespace errors.

```bash
git add bridge/README.md
git commit -m "docs(bridge): add secure local runbook"
```
