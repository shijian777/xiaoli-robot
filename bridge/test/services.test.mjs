import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AsrUnavailableError} from '../src/agent-stack/client.mjs';
import {AsrService} from '../src/agent-stack/asr-service.mjs';
import {MediatorService} from '../src/agent-stack/mediator-service.mjs';
import {WhisperService} from '../src/fallback/whisper-service.mjs';
import {pcmToWav} from '../src/audio/wav.mjs';
import {startBridge} from '../src/server.mjs';
import * as serverModule from '../src/server.mjs';

const mediation = {
  conflictSummary: '双方对家务分工有不同看法。',
  aPosition: 'A 认为分工不均。',
  bPosition: 'B 认为沟通方式令人难受。',
  aCanImprove: 'A 可以更具体地表达需求。',
  bCanImprove: 'B 可以先确认对方感受。',
  commonGround: '双方都希望家庭生活更轻松。',
  suggestions: ['列出本周家务并共同确认。'],
  spokenText: '你们都希望家务安排更公平，也希望沟通时被尊重。可以先列出本周家务，再一起确认分工和调整时间。'
};

const caseSnapshot = {
  deviceId: 'device-1',
  caseId: 'case-1',
  speakers: {
    A: [
      {segmentId: 'a-1', speaker: 'A', state: 'saved', transcript: '我觉得家务总是我在做。', audio: {sampleRate: 16000}},
      {segmentId: 'a-failed', speaker: 'A', state: 'failed', transcript: '不得发送失败片段', failure: 'private failure'},
      {segmentId: 'a-empty', speaker: 'A', state: 'saved', transcript: '   '}
    ],
    B: [{segmentId: 'b-1', speaker: 'B', state: 'saved', transcript: '我觉得你总是在指责我。'}]
  },
  canMediate: true
};

const mediationInput = {
  caseId: 'case-1',
  A: [{index: 1, text: '我觉得家务总是我在做。'}],
  B: [{index: 1, text: '我觉得你总是在指责我。'}],
  requirements: {neutral: true, noWinner: true, language: 'zh-CN'}
};

function promptCaseJson(prompt) {
  return prompt.split('\n').find((line) => line.startsWith('{"caseId":'));
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-services-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function captureRejectionWithin(promise, milliseconds = 50) {
  let timer;
  try {
    return await Promise.race([
      promise.then(
        () => new Error('operation resolved unexpectedly'),
        (error) => error
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(new Error('operation did not settle at its bound')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function settleWithin(promise, milliseconds = 1_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('operation did not settle within its bound')), milliseconds);
      timer.unref?.();
    })
  ]);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

function scheduledTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, milliseconds) {
      timers.push({callback, milliseconds});
      return {unref() {}};
    },
    clearTimeout() {}
  };
}

async function flush() {
  await new Promise((resolve) => queueMicrotask(resolve));
}

async function waitForFirstTimer(clock) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (clock.timers.length > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Whisper did not schedule its timeout');
}

function agentClient({message = JSON.stringify({transcript: '  本地音频转写  ', unclear: false}), error} = {}) {
  return {
    async createSession(agentId) {
      assert.equal(agentId, 'asr-agent');
      return 'asr-session';
    },
    async runAudioTurn(sessionId, wav, name) {
      assert.equal(sessionId, 'asr-session');
      assert.ok(Buffer.isBuffer(wav));
      assert.equal(name, 'segment-1.wav');
      if (error) throw error;
      return {assistantMessage: message};
    }
  };
}

test('AsrService leaves its Bridge-owned input WAV for the Gateway job owner on success', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'owner-success.wav');
    const wav = Buffer.from('RIFF');
    await writeFile(wavPath, wav);
    const service = new AsrService({client: agentClient(), asrAgentId: 'asr-agent', tempDir});

    assert.equal(await service.transcribe(wavPath, {
      caseId: 'case-1', segmentId: 'segment-1'
    }), '本地音频转写');
    assert.deepEqual(await readFile(wavPath), wav);
  });
});

test('AsrService leaves its Bridge-owned input WAV for retry after provider failure', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'owner-failure.wav');
    const wav = Buffer.from('RIFF');
    await writeFile(wavPath, wav);
    const service = new AsrService({
      client: agentClient({error: new Error('provider unavailable')}),
      asrAgentId: 'asr-agent',
      tempDir
    });

    await assert.rejects(() => service.transcribe(wavPath, {
      caseId: 'case-1', segmentId: 'segment-1'
    }), /provider unavailable/);
    assert.deepEqual(await readFile(wavPath), wav);
  });
});

test('AsrService leaves its Bridge-owned input WAV when cancellation interrupts the provider', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'owner-cancel.wav');
    const wav = pcmToWav(Buffer.from([1, 0]), {sampleRate: 16000, bits: 16, channels: 1});
    await writeFile(wavPath, wav);
    const started = deferred();
    const service = new AsrService({
      tempDir,
      rtasr: {async transcribe(_pcm, {signal}) {
        started.resolve();
        return new Promise((resolve, reject) => signal.addEventListener(
          'abort', () => reject(signal.reason), {once: true}
        ));
      }}
    });
    const controller = new AbortController();
    const pending = service.transcribe(wavPath, {
      caseId: 'case-1', segmentId: 'segment-1', signal: controller.signal
    });
    await started.promise;
    controller.abort(new Error('cancelled by owner'));

    await assert.rejects(pending, /cancelled by owner/);
    assert.deepEqual(await readFile(wavPath), wav);
  });
});

test('AsrService accepts one fenced transcript object and leaves its bridge WAV to the owner', async () => {
  await withTempDirectory(async (tempDir) => {
    for (const fence of ['```json', '```']) {
      const wavPath = path.join(tempDir, `${fence.length}.wav`);
      await writeFile(wavPath, Buffer.from('RIFF'));
      const client = agentClient({message: `${fence}\n{"transcript":"本地音频转写","unclear":false}\n${'```'} `});
      const service = new AsrService({client, asrAgentId: 'asr-agent', tempDir});

      assert.equal(await service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}), '本地音频转写');
      assert.deepEqual(await readFile(wavPath), Buffer.from('RIFF'));
    }
  });
});

test('AsrService sends approved PCM to Xfyun before Agent Stack and leaves its bridge WAV to the owner', async () => {
  await withTempDirectory(async (tempDir) => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const wavPath = path.join(tempDir, 'xfyun-primary.wav');
    await writeFile(wavPath, pcmToWav(pcm, {sampleRate: 16000, bits: 16, channels: 1}));
    const controller = new AbortController();
    let receivedSignal;
    const service = new AsrService({
      tempDir,
      rtasr: {
        async transcribe(receivedPcm, {signal}) {
          assert.deepEqual(receivedPcm, pcm);
          receivedSignal = signal;
          return '  讯飞最终文字  ';
        }
      }
    });

    assert.equal(await service.transcribe(wavPath, {
      caseId: 'case-1', segmentId: 'segment-1', signal: controller.signal
    }), '讯飞最终文字');
    assert.equal(receivedSignal, controller.signal);
    assert.ok((await readFile(wavPath)).length > 44);
  });
});

test('AsrService surfaces an Xfyun failure without calling Agent Stack or Whisper', async () => {
  await withTempDirectory(async (tempDir) => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    const wavPath = path.join(tempDir, 'xfyun-failure.wav');
    await writeFile(wavPath, pcmToWav(pcm, {sampleRate: 16000, bits: 16, channels: 1}));
    const xfyunError = new Error('sanitized Xfyun failure');
    let agentCalls = 0;
    let whisperCalls = 0;
    const service = new AsrService({
      client: {
        async createSession() { agentCalls += 1; return 'asr-session'; },
        async runAudioTurn() { agentCalls += 1; return {assistantMessage: 'unused'}; }
      },
      asrAgentId: 'asr-agent',
      tempDir,
      whisper: {async transcribe() { whisperCalls += 1; return 'unused'; }},
      rtasr: {
        async transcribe() { throw xfyunError; }
      }
    });

    await assert.rejects(
      () => service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}),
      (error) => error === xfyunError
    );
    assert.equal(agentCalls, 0);
    assert.equal(whisperCalls, 0);
    assert.ok((await readFile(wavPath)).length > 44);
  });
});

test('AsrService rejects an empty Xfyun result without calling Agent Stack or Whisper', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'xfyun-empty.wav');
    await writeFile(wavPath, pcmToWav(Buffer.from([1, 0]), {sampleRate: 16000, bits: 16, channels: 1}));
    let agentCalls = 0;
    let whisperCalls = 0;
    const service = new AsrService({
      client: {
        async createSession() { agentCalls += 1; return 'unused'; },
        async runAudioTurn() { agentCalls += 1; return {assistantMessage: 'unused'}; }
      },
      asrAgentId: 'asr-agent',
      tempDir,
      whisper: {async transcribe() { whisperCalls += 1; return 'unused'; }},
      rtasr: {async transcribe() { return '   '; }}
    });

    await assert.rejects(
      () => service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}),
      /Xfyun.*empty/i
    );
    assert.equal(agentCalls, 0);
    assert.equal(whisperCalls, 0);
    assert.ok((await readFile(wavPath)).length > 44);
  });
});

test('AsrService still requires Agent Stack ASR dependencies when Xfyun is absent', () => {
  assert.throws(() => new AsrService({tempDir: 'tmp'}), /Agent Stack client/);
  assert.throws(() => new AsrService({
    tempDir: 'tmp',
    client: {async createSession() {}, async runAudioTurn() {}}
  }), /asrAgentId/);
});

test('startBridge accepts Xfyun-only ASR with an Agent Stack client that has no audio methods', async () => {
  await withTempDirectory(async (tempDir) => {
    const bonjour = {
      publish() { return {stop(callback) { callback?.(); }}; },
      destroy(callback) { callback?.(); }
    };
    const bridge = await startBridge({
      config: {
        baseUrl: 'https://agent-stack.test',
        uak: 'synthetic-uak',
        projectId: 'project-test',
        asrAgentId: null,
        mediatorAgentId: 'mediator-test',
        deviceToken: 'device-test-token',
        host: '127.0.0.1',
        port: 0,
        pythonBin: 'must-not-be-used',
        whisperModel: 'small',
        tempDir,
        xfyunRtasr: {appId: 'synthetic-app', apiKey: 'synthetic-key'}
      },
      client: {
        async createSession() { return 'mediator-session'; },
        async runTextTurn() { return {assistantMessage: JSON.stringify(mediation)}; }
      },
      rtasrClient: {async transcribe() { return '讯飞转写'; }},
      ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
      bonjourFactory: () => bonjour,
      logger: {info() {}, warn() {}, error() {}}
    });
    await bridge.shutdown();
  });
});

test('startBridge preserves an injected Xfyun client as the ASR mode selector', async () => {
  await withTempDirectory(async (tempDir) => {
    const bonjour = {
      publish() { return {stop(callback) { callback?.(); }}; },
      destroy(callback) { callback?.(); }
    };
    const bridge = await startBridge({
      config: {
        baseUrl: 'https://agent-stack.test',
        uak: 'synthetic-uak',
        projectId: 'project-test',
        asrAgentId: null,
        mediatorAgentId: 'mediator-test',
        deviceToken: 'device-test-token',
        host: '127.0.0.1',
        port: 0,
        tempDir,
        xfyunRtasr: null
      },
      client: {
        async createSession() { return 'mediator-session'; },
        async runTextTurn() { return {assistantMessage: JSON.stringify(mediation)}; }
      },
      rtasrClient: {async transcribe() { return '注入的讯飞转写'; }},
      ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
      bonjourFactory: () => bonjour,
      logger: {info() {}, warn() {}, error() {}}
    });
    await bridge.shutdown();
  });
});

test('AsrService rejects malformed or empty transcripts and leaves the bridge WAV for retry', async () => {
  await withTempDirectory(async (tempDir) => {
    for (const [index, message] of [
      JSON.stringify({transcript: 'text'}),
      JSON.stringify({transcript: '', unclear: false}),
      JSON.stringify({transcript: 'text', unclear: false, speaker: 'A'})
    ].entries()) {
      const wavPath = path.join(tempDir, `invalid-${index}.wav`);
      await writeFile(wavPath, Buffer.from('RIFF'));
      const service = new AsrService({client: agentClient({message}), asrAgentId: 'asr-agent', tempDir});

      await assert.rejects(() => service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}), /transcript/i);
      assert.deepEqual(await readFile(wavPath), Buffer.from('RIFF'));
    }
  });
});

test('AsrService calls Whisper exactly once only when Agent Stack ASR is unavailable', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'fallback.wav');
    await writeFile(wavPath, Buffer.from('RIFF'));
    let fallbackCalls = 0;
    let fallbackPath;
    const service = new AsrService({
      client: agentClient({error: new AsrUnavailableError()}),
      asrAgentId: 'asr-agent',
      tempDir,
      whisper: {async transcribe(candidatePath) {
        fallbackCalls += 1;
        fallbackPath = candidatePath;
        assert.notEqual(candidatePath, wavPath);
        assert.deepEqual(await readFile(candidatePath), Buffer.from('RIFF'));
        return '离线转写';
      }}
    });

    assert.equal(await service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}), '离线转写');
    assert.equal(fallbackCalls, 1);
    assert.deepEqual(await readFile(wavPath), Buffer.from('RIFF'));
    await assert.rejects(() => readFile(fallbackPath), {code: 'ENOENT'});
  });
});

test('AsrService stages validated WAV bytes for Whisper when the original path changes', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'fallback-race.wav');
    const validatedWav = Buffer.from('validated WAV bytes');
    await writeFile(wavPath, validatedWav);
    let fallbackPath;
    const service = new AsrService({
      client: agentClient({error: new AsrUnavailableError()}),
      asrAgentId: 'asr-agent',
      tempDir,
      whisper: {async transcribe(candidatePath) {
        fallbackPath = candidatePath;
        assert.notEqual(candidatePath, wavPath);
        await writeFile(wavPath, Buffer.from('replaced WAV bytes'));
        assert.deepEqual(await readFile(candidatePath), validatedWav);
        return '离线转写';
      }}
    });

    assert.equal(await service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}), '离线转写');
    assert.deepEqual(await readFile(wavPath), Buffer.from('replaced WAV bytes'));
    await assert.rejects(() => readFile(fallbackPath), {code: 'ENOENT'});
    await assert.rejects(() => readFile(path.dirname(fallbackPath)), {code: 'ENOENT'});
  });
});

test('AsrService retries a locked deferred Whisper input cleanup without leaking its directory', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'fallback-locked.wav');
    await writeFile(wavPath, Buffer.from('RIFF'));
    let fallbackPath;
    let inputRemoveAttempts = 0;
    const service = new AsrService({
      client: agentClient({error: new AsrUnavailableError()}),
      asrAgentId: 'asr-agent',
      tempDir,
      async removeFile(candidate, options) {
        if (candidate.endsWith('input.wav') && ++inputRemoveAttempts === 1) {
          throw Object.assign(new Error('locked'), {code: 'EBUSY'});
        }
        return rm(candidate, options);
      },
      whisper: {async transcribe(candidatePath, {cleanupAfterClose}) {
        fallbackPath = candidatePath;
        await cleanupAfterClose();
        return '锁定清理后转写';
      }}
    });

    assert.equal(await service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}), '锁定清理后转写');
    assert.equal(inputRemoveAttempts, 2);
    await assert.rejects(() => readFile(fallbackPath), {code: 'ENOENT'});
    await assert.rejects(() => readFile(path.dirname(fallbackPath)), {code: 'ENOENT'});
  });
});

test('AsrService keeps a no-close Whisper input until the child closes late', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'fallback-deferred.wav');
    await writeFile(wavPath, Buffer.from('RIFF'));
    const child = fakeChild();
    const taskkill = fakeChild();
    const clock = scheduledTimers();
    const spawned = [];
    const whisperStarted = deferred();
    const whisper = new WhisperService({
      scriptPath: 'C:/bridge/scripts/transcribe.py',
      spawn(command, args) {
        spawned.push({command, args});
        if (command !== 'taskkill') whisperStarted.resolve();
        return command === 'taskkill' ? taskkill : child;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    const service = new AsrService({
      client: agentClient({error: new AsrUnavailableError()}),
      asrAgentId: 'asr-agent',
      tempDir,
      whisper
    });

    const pending = service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'});
    void pending.catch(() => {});
    await settleWithin(whisperStarted.promise);
    const fallbackPath = spawned[0].args.at(-1);
    clock.timers[0].callback();
    clock.timers[1].callback();
    clock.timers[2].callback();
    await assert.rejects(pending, /timed out/i);

    assert.deepEqual(await readFile(fallbackPath), Buffer.from('RIFF'));
    assert.deepEqual(await readFile(wavPath), Buffer.from('RIFF'));
    child.emit('close', 1, null);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(path.dirname(fallbackPath));
        await new Promise((resolve) => setImmediate(resolve));
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
    await assert.rejects(() => readFile(fallbackPath), {code: 'ENOENT'});
    await assert.rejects(() => stat(path.dirname(fallbackPath)), {code: 'ENOENT'});
  });
});

test('AsrService does not call Whisper for a non-availability Agent Stack failure', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'failure.wav');
    await writeFile(wavPath, Buffer.from('RIFF'));
    let fallbackCalls = 0;
    const service = new AsrService({
      client: agentClient({error: new Error('network failure')}),
      asrAgentId: 'asr-agent',
      tempDir,
      whisper: {async transcribe() { fallbackCalls += 1; return 'unexpected'; }}
    });

    await assert.rejects(() => service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}), /network failure/);
    assert.equal(fallbackCalls, 0);
    assert.deepEqual(await readFile(wavPath), Buffer.from('RIFF'));
  });
});

test('AsrService refuses a WAV outside its bridge temp directory without opening or deleting it', async () => {
  await withTempDirectory(async (tempDir) => {
    const outside = path.join(path.dirname(tempDir), 'outside.wav');
    await writeFile(outside, Buffer.from('RIFF'));
    try {
      const service = new AsrService({client: agentClient(), asrAgentId: 'asr-agent', tempDir});
      await assert.rejects(() => service.transcribe(outside, {caseId: 'case-1', segmentId: 'segment-1'}), /tempDir|Bridge-created/i);
      assert.deepEqual(await readFile(outside), Buffer.from('RIFF'));
    } finally {
      await rm(outside, {force: true});
    }
  });
});

test('AsrService rejects a symlink in its temp directory without opening or deleting its target', async (t) => {
  await withTempDirectory(async (tempDir) => {
    const outside = path.join(path.dirname(tempDir), 'outside-symlink.wav');
    const link = path.join(tempDir, 'linked.wav');
    await writeFile(outside, Buffer.from('RIFF'));
    try {
      try {
        await symlink(outside, link, 'file');
      } catch (error) {
        if (error?.code === 'EPERM') {
          t.skip('creating symlinks is not permitted on this Windows host');
          return;
        }
        throw error;
      }
      const service = new AsrService({client: agentClient(), asrAgentId: 'asr-agent', tempDir});
      await assert.rejects(() => service.transcribe(link, {caseId: 'case-1', segmentId: 'segment-1'}), /tempDir|Bridge-created/i);
      assert.deepEqual(await readFile(outside), Buffer.from('RIFF'));
      assert.deepEqual(await readFile(link), Buffer.from('RIFF'));
    } finally {
      await rm(link, {force: true});
      await rm(outside, {force: true});
    }
  });
});

test('AsrService propagates one cancellation signal through Session creation and the audio Turn', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'cancel.wav');
    await writeFile(wavPath, Buffer.from('RIFF'));
    const controller = new AbortController();
    const service = new AsrService({
      asrAgentId: 'asr-agent',
      tempDir,
      client: {
        async createSession(agentId, options) {
          assert.equal(agentId, 'asr-agent');
          assert.equal(options.signal, controller.signal);
          return 'asr-session';
        },
        async runAudioTurn(sessionId, _wav, name, options) {
          assert.equal(sessionId, 'asr-session');
          assert.equal(name, 'segment-1.wav');
          assert.equal(options.signal, controller.signal);
          return {assistantMessage: JSON.stringify({transcript: '可取消转写', unclear: false})};
        }
      }
    });

    assert.equal(await service.transcribe(wavPath, {
      caseId: 'case-1', segmentId: 'segment-1', signal: controller.signal
    }), '可取消转写');
    assert.deepEqual(await readFile(wavPath), Buffer.from('RIFF'));
  });
});

test('AsrService forgets the local Agent Stack session when a case is evicted', async () => {
  await withTempDirectory(async (tempDir) => {
    const createdSessions = [];
    const client = {
      async createSession() {
        const sessionId = `asr-session-${createdSessions.length + 1}`;
        createdSessions.push(sessionId);
        return sessionId;
      },
      async runAudioTurn() {
        return {assistantMessage: JSON.stringify({transcript: '已保存转写', unclear: false})};
      }
    };
    const service = new AsrService({client, asrAgentId: 'asr-agent', tempDir});
    for (const [filename, segmentId] of [['first.wav', 'segment-1'], ['second.wav', 'segment-2']]) {
      const wavPath = path.join(tempDir, filename);
      await writeFile(wavPath, Buffer.from('RIFF'));
      assert.equal(await service.transcribe(wavPath, {caseId: 'case-1', segmentId}), '已保存转写');
    }
    assert.deepEqual(createdSessions, ['asr-session-1']);

    service.forgetCase('case-1');
    const replacementWav = path.join(tempDir, 'replacement.wav');
    await writeFile(replacementWav, Buffer.from('RIFF'));
    assert.equal(await service.transcribe(replacementWav, {caseId: 'case-1', segmentId: 'segment-3'}), '已保存转写');
    assert.deepEqual(createdSessions, ['asr-session-1', 'asr-session-2']);
  });
});

test('MediatorService serializes only the approved mediation DTO and rejects incomplete output', async () => {
  let prompt;
  const service = new MediatorService({client: {
    async runTextTurn(sessionId, candidatePrompt) {
      assert.equal(sessionId, 'mediator-session');
      prompt = candidatePrompt;
      return {assistantMessage: JSON.stringify({...mediation, bPosition: undefined})};
    }
  }});

  await assert.rejects(() => service.mediate(caseSnapshot, 'mediator-session'), /mediation result/i);
  assert.equal(promptCaseJson(prompt), JSON.stringify(mediationInput));
  assert.doesNotMatch(prompt, /device-1|a-failed|private failure|sampleRate|canMediate/);
  assert.match(prompt, /保持中立/);
  assert.match(prompt, /区分双方主张与已经证实的事实/);
  assert.match(prompt, /暴力、自残、虐待或即时危险/);
  const orderedGuidance = [
    '总结冲突',
    '双方立场、情绪和需求',
    '各自可改进',
    '可能存在的误会',
    '共同点',
    '可执行步骤',
    '简短、中立的 spokenText'
  ];
  let previousGuidanceIndex = -1;
  for (const guidance of orderedGuidance) {
    const guidanceIndex = prompt.indexOf(guidance);
    assert.ok(guidanceIndex > previousGuidanceIndex, `${guidance} must appear in the approved order`);
    previousGuidanceIndex = guidanceIndex;
  }
  const outputShape = prompt.split('\n').find((line) => line.startsWith('{"conflictSummary":"non-empty string"'));
  assert.equal(typeof outputShape, 'string');
  assert.deepEqual(JSON.parse(outputShape), {
    conflictSummary: 'non-empty string',
    aPosition: 'non-empty string',
    bPosition: 'non-empty string',
    aCanImprove: 'non-empty string',
    bCanImprove: 'non-empty string',
    commonGround: 'non-empty string',
    suggestions: ['non-empty string'],
    spokenText: 'non-empty string, max 100 characters'
  });
  assert.match(prompt, /suggestions.*至少.*一个.*非空字符串/);
  assert.match(prompt, /spokenText.*100/);
});

test('MediatorService rejects an aggregate prompt above 32000 characters before the text Turn', async () => {
  let turnCalls = 0;
  const oversized = structuredClone(caseSnapshot);
  oversized.speakers.A = [{state: 'saved', transcript: 'private-marker'.repeat(1_300)}];
  oversized.speakers.B = [{state: 'saved', transcript: 'private-marker'.repeat(1_300)}];
  const service = new MediatorService({client: {
    async runTextTurn() {
      turnCalls += 1;
      return {assistantMessage: JSON.stringify(mediation)};
    }
  }});

  await assert.rejects(
    () => service.mediate(oversized, 'mediator-session'),
    (error) => /32000-character prompt limit/.test(error.message) && !/private-marker/.test(error.message)
  );
  assert.equal(turnCalls, 0);
});

test('MediatorService accepts 100 spoken characters and rejects 101', async () => {
  for (const [length, accepted] of [[100, true], [101, false]]) {
    const service = new MediatorService({client: {
      async runTextTurn() {
        return {assistantMessage: JSON.stringify({...mediation, spokenText: '中'.repeat(length)})};
      }
    }});
    if (accepted) {
      assert.equal((await service.mediate(caseSnapshot, 'mediator-session')).spokenText.length, 100);
    } else {
      await assert.rejects(() => service.mediate(caseSnapshot, 'mediator-session'), /mediation result/i);
    }
  }
});

test('MediatorService returns a canonical valid mediation result', async () => {
  const service = new MediatorService({client: {
    async runTextTurn() {
      return {assistantMessage: JSON.stringify(mediation)};
    }
  }});

  assert.deepEqual(await service.mediate(caseSnapshot, 'mediator-session'), mediation);
});

test('MediatorService accepts exactly one complete JSON or unlabelled code fence', async () => {
  for (const openingFence of ['```json', '```']) {
    const service = new MediatorService({client: {
      async runTextTurn() {
        return {assistantMessage: `${openingFence}\n${JSON.stringify(mediation)}\n${'```'}`};
      }
    }});

    assert.deepEqual(await service.mediate(caseSnapshot, 'mediator-session'), mediation);
  }
});

test('MediatorService rejects prose, partial fences, multiple fences, and trailing content', async () => {
  const validJson = JSON.stringify(mediation);
  for (const message of [
    `Here is the result:\n${validJson}`,
    `${'```json'}\n${validJson}`,
    `${'```json'}\n${validJson}\n${'```'}\nextra`,
    `${'```json'}\n${validJson}\n${'```'}\n${'```json'}\n${validJson}\n${'```'}`
  ]) {
    const service = new MediatorService({client: {
      async runTextTurn() { return {assistantMessage: message}; }
    }});
    await assert.rejects(() => service.mediate(caseSnapshot, 'mediator-session'), /valid JSON/i);
  }
});

test('MediatorService propagates the cancellation signal to its text Turn', async () => {
  const controller = new AbortController();
  const service = new MediatorService({client: {
    async runTextTurn(_sessionId, _prompt, options) {
      assert.equal(options.signal, controller.signal);
      return {assistantMessage: JSON.stringify(mediation)};
    }
  }});

  assert.deepEqual(await service.mediate(caseSnapshot, 'mediator-session', {signal: controller.signal}), mediation);
});

test('WhisperService spawns the deterministic CLI without a shell and parses its one-line transcript', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const service = new WhisperService({
    pythonBin: 'python-test',
    whisperModel: 'small',
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn(command, args, options) {
      calls.push({command, args, options});
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"transcript":"离线结果"}\n'));
        child.emit('close', 0, null);
      });
      return child;
    }
  });

  assert.equal(await service.transcribe('C:/bridge/tmp/segment.wav'), '离线结果');
  assert.deepEqual(calls, [{
    command: 'python-test',
    args: ['C:/bridge/scripts/transcribe.py', '--model', 'small', '--input', 'C:/bridge/tmp/segment.wav'],
    options: {shell: false}
  }]);
});

test('WhisperService pins every fallback invocation to the small model', async () => {
  const child = fakeChild();
  const calls = [];
  const service = new WhisperService({
    pythonBin: 'python-test',
    whisperModel: 'large-v3',
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn(command, args) {
      calls.push({command, args});
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"transcript":"离线结果"}\n'));
        child.emit('close', 0, null);
      });
      return child;
    }
  });

  assert.equal(await service.transcribe('C:/bridge/tmp/segment.wav'), '离线结果');
  assert.deepEqual(calls[0].args.slice(0, 3), ['C:/bridge/scripts/transcribe.py', '--model', 'small']);
});

test('WhisperService force-terminates a no-close child and settles with deferred cleanup', async () => {
  const child = fakeChild();
  const taskkill = fakeChild();
  const clock = scheduledTimers();
  const spawned = [];
  let cleanupCalls = 0;
  const service = new WhisperService({
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn(command, args, options) {
      spawned.push({command, args, options});
      return command === 'taskkill' ? taskkill : child;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  const pending = service.transcribe('C:/bridge/tmp/segment.wav', {
    cleanupAfterClose: async () => { cleanupCalls += 1; }
  });
  await waitForFirstTimer(clock);
  clock.timers[0].callback();
  assert.equal(child.killCalls, 1);
  assert.equal(cleanupCalls, 0);
  assert.equal(clock.timers[1].milliseconds, 1_000);
  clock.timers[1].callback();
  assert.deepEqual(spawned[1], {
    command: 'taskkill',
    args: ['/PID', '4321', '/T', '/F'],
    options: {shell: false, windowsHide: true}
  });
  assert.equal(clock.timers[2].milliseconds, 1_000);
  clock.timers[2].callback();

  const error = await captureRejectionWithin(pending);
  assert.match(error.message, /timed out/i);
  assert.equal(error.cleanupDeferred, true);
  assert.equal(cleanupCalls, 0);
  assert.equal(child.stderr.listenerCount('data'), 1);
  assert.doesNotThrow(() => child.emit('error', new Error('late untrusted error')));
});

test('WhisperService defers overflow cleanup until late close and runs it exactly once', async () => {
  const child = fakeChild();
  const taskkill = fakeChild();
  const clock = scheduledTimers();
  let cleanupCalls = 0;
  const service = new WhisperService({
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn(command) { return command === 'taskkill' ? taskkill : child; },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  const pending = service.transcribe('C:/bridge/tmp/segment.wav', {
    cleanupAfterClose: async () => { cleanupCalls += 1; }
  });
  await waitForFirstTimer(clock);
  child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1));
  assert.equal(child.killCalls, 1);
  clock.timers[1].callback();
  clock.timers[2].callback();
  const error = await captureRejectionWithin(pending);
  assert.match(error.message, /exceeded 1 MiB/i);
  assert.equal(error.cleanupDeferred, true);
  assert.equal(cleanupCalls, 0);
  assert.equal(child.stderr.listenerCount('data'), 1);

  child.emit('close', 1, null);
  await flush();
  assert.equal(cleanupCalls, 1);
  assert.equal(child.stderr.listenerCount('data'), 0);
  child.emit('close', 1, null);
  await flush();
  assert.equal(cleanupCalls, 1);
  assert.doesNotThrow(() => child.emit('error', new Error('late error after close')));
});

test('WhisperService drains and bounds stderr without surfacing its contents', async () => {
  const child = fakeChild();
  const service = new WhisperService({
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn() { return child; }
  });
  const pending = service.transcribe('C:/bridge/tmp/segment.wav');
  child.stderr.emit('data', Buffer.concat([Buffer.from('sensitive-audio-text:'), Buffer.alloc(64 * 1024)]));
  child.emit('close', 1, null);

  const error = await captureRejectionWithin(pending);
  assert.match(error.message, /diagnostic output exceeded/i);
  assert.doesNotMatch(error.message, /sensitive-audio-text/);
});

test('WhisperService preserves UTF-8 when transcript JSON splits a Chinese character across chunks', async () => {
  const child = fakeChild();
  const output = Buffer.from('{"transcript":"离线结果"}\n');
  const splitAt = Buffer.byteLength('{"transcript":"') + 1;
  const service = new WhisperService({
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn() {
      queueMicrotask(() => {
        child.stdout.emit('data', output.subarray(0, splitAt));
        child.stdout.emit('data', output.subarray(splitAt));
        child.emit('close', 0, null);
      });
      return child;
    }
  });

  assert.equal(await service.transcribe('C:/bridge/tmp/segment.wav'), '离线结果');
});

test('WhisperService rejects blank lines around its one-line JSON output', async () => {
  const child = fakeChild();
  const service = new WhisperService({
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn() {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('\n{"transcript":"离线结果"}\n\n'));
        child.emit('close', 0, null);
      });
      return child;
    }
  });

  await assert.rejects(() => service.transcribe('C:/bridge/tmp/segment.wav'), /one JSON line/i);
});

test('WhisperService rejects an empty transcript from its child process', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const service = new WhisperService({
    pythonBin: 'python-test',
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn() {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"transcript":""}\n'));
        child.emit('close', 0, null);
      });
      return child;
    }
  });

  await assert.rejects(() => service.transcribe('C:/bridge/tmp/segment.wav'), /empty transcript/i);
});

test('WhisperService kills its child and rejects when the caller aborts', async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const service = new WhisperService({
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn() { return child; }
  });

  const pending = service.transcribe('C:/bridge/tmp/segment.wav', {signal: controller.signal});
  controller.abort();
  child.emit('close', 1, null);
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(child.killCalls, 1);
});

test('startBridge skips Bonjour entirely when mDNS is disabled', async () => {
  await withTempDirectory(async (tempDir) => {
    let bonjourFactoryCalls = 0;
    const bridge = await startBridge({
      config: {
        baseUrl: 'https://agent-stack.test',
        uak: 'synthetic-uak',
        projectId: 'project-test',
        asrAgentId: 'asr-test',
        mediatorAgentId: 'mediator-test',
        deviceToken: 'device-test-token',
        host: '127.0.0.1',
        port: 0,
        tempDir,
        mdnsEnabled: false,
        xfyunRtasr: null
      },
      asrService: {async transcribe() { return 'unused'; }},
      mediatorService: {async mediate() { return mediation; }},
      ttsService: {async synthesize() { return Buffer.from([1, 0]); }},
      client: {async createSession() { return 'unused'; }},
      bonjourFactory() {
        bonjourFactoryCalls += 1;
        throw new Error('Bonjour must not be constructed when disabled');
      },
      logger: {info() {}, warn() {}, error() {}}
    });
    try {
      assert.equal(bonjourFactoryCalls, 0);
    } finally {
      await bridge.shutdown();
    }
  });
});

test('registerGracefulShutdown handles SIGTERM and SIGINT through one shutdown', async () => {
  assert.equal(typeof serverModule.registerGracefulShutdown, 'function');
  const handlers = new Map();
  const exits = [];
  const cleared = [];
  let shutdownCalls = 0;
  const timer = {name: 'hard-stop'};
  serverModule.registerGracefulShutdown({
    runtime: {async shutdown() { shutdownCalls += 1; }},
    processRef: {once(signal, handler) { handlers.set(signal, handler); }},
    exit(code) { exits.push(code); },
    setTimer(callback, delay) {
      assert.equal(delay, 6_000);
      return timer;
    },
    clearTimer(value) { cleared.push(value); }
  });

  handlers.get('SIGTERM')();
  handlers.get('SIGINT')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCalls, 1);
  assert.deepEqual(cleared, [timer]);
  assert.deepEqual(exits, [0]);
});

test('runBridgeMain registers normal signal shutdown and propagates a runtime fatal', async () => {
  const fatal = Object.assign(new Error('persistent state unavailable'), {code: 'EIO'});
  const runtime = {fatal: Promise.resolve(fatal), async shutdown() {}};
  let registeredRuntime;

  await assert.rejects(() => serverModule.runBridgeMain({
    startBridgeFn: async () => runtime,
    registerGracefulShutdownFn({runtime: candidate}) { registeredRuntime = candidate; }
  }), (error) => error === fatal);
  assert.equal(registeredRuntime, runtime);
});
