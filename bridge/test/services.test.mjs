import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AsrUnavailableError} from '../src/agent-stack/client.mjs';
import {AsrService} from '../src/agent-stack/asr-service.mjs';
import {MediatorService} from '../src/agent-stack/mediator-service.mjs';
import {WhisperService} from '../src/fallback/whisper-service.mjs';

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
    A: [{segmentId: 'a-1', speaker: 'A', transcript: '我觉得家务总是我在做。'}],
    B: [{segmentId: 'b-1', speaker: 'B', transcript: '我觉得你总是在指责我。'}]
  },
  canMediate: true
};

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

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
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

test('AsrService accepts one fenced transcript object and removes its bridge WAV', async () => {
  await withTempDirectory(async (tempDir) => {
    for (const fence of ['```json', '```']) {
      const wavPath = path.join(tempDir, `${fence.length}.wav`);
      await writeFile(wavPath, Buffer.from('RIFF'));
      const client = agentClient({message: `${fence}\n{"transcript":"本地音频转写","unclear":false}\n${'```'} `});
      const service = new AsrService({client, asrAgentId: 'asr-agent', tempDir});

      assert.equal(await service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}), '本地音频转写');
      await assert.rejects(() => readFile(wavPath), {code: 'ENOENT'});
    }
  });
});

test('AsrService rejects malformed or empty transcripts and still removes the bridge WAV', async () => {
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
      await assert.rejects(() => readFile(wavPath), {code: 'ENOENT'});
    }
  });
});

test('AsrService calls Whisper exactly once only when Agent Stack ASR is unavailable', async () => {
  await withTempDirectory(async (tempDir) => {
    const wavPath = path.join(tempDir, 'fallback.wav');
    await writeFile(wavPath, Buffer.from('RIFF'));
    let fallbackCalls = 0;
    const service = new AsrService({
      client: agentClient({error: new AsrUnavailableError()}),
      asrAgentId: 'asr-agent',
      tempDir,
      whisper: {async transcribe(candidatePath) {
        fallbackCalls += 1;
        assert.equal(candidatePath, wavPath);
        return '离线转写';
      }}
    });

    assert.equal(await service.transcribe(wavPath, {caseId: 'case-1', segmentId: 'segment-1'}), '离线转写');
    assert.equal(fallbackCalls, 1);
    await assert.rejects(() => readFile(wavPath), {code: 'ENOENT'});
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
    await assert.rejects(() => readFile(wavPath), {code: 'ENOENT'});
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

test('MediatorService sends approved case JSON and rejects incomplete mediation output', async () => {
  let prompt;
  const service = new MediatorService({client: {
    async runTextTurn(sessionId, candidatePrompt) {
      assert.equal(sessionId, 'mediator-session');
      prompt = candidatePrompt;
      return {assistantMessage: JSON.stringify({...mediation, bPosition: undefined})};
    }
  }});

  await assert.rejects(() => service.mediate(caseSnapshot, 'mediator-session'), /mediation result/i);
  assert.match(prompt, new RegExp(JSON.stringify(caseSnapshot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /保持中立/);
  assert.match(prompt, /区分双方主张与已经证实的事实/);
  assert.match(prompt, /暴力、自残、虐待或即时危险/);
});

test('MediatorService rejects spoken text above 700 Chinese characters', async () => {
  const service = new MediatorService({client: {
    async runTextTurn() {
      return {assistantMessage: JSON.stringify({...mediation, spokenText: '中'.repeat(701)})};
    }
  }});

  await assert.rejects(() => service.mediate(caseSnapshot, 'mediator-session'), /mediation result/i);
});

test('MediatorService returns a canonical valid mediation result', async () => {
  const service = new MediatorService({client: {
    async runTextTurn() {
      return {assistantMessage: JSON.stringify(mediation)};
    }
  }});

  assert.deepEqual(await service.mediate(caseSnapshot, 'mediator-session'), mediation);
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

test('WhisperService settles at its timeout even when a killed child never closes', async () => {
  const child = fakeChild();
  const scheduled = [];
  const service = new WhisperService({
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn() { return child; },
    setTimeout(callback, milliseconds) {
      scheduled.push(milliseconds);
      queueMicrotask(callback);
      return {unref() {}};
    },
    clearTimeout() {}
  });

  const error = await captureRejectionWithin(service.transcribe('C:/bridge/tmp/segment.wav'));
  assert.match(error.message, /timed out/i);
  assert.deepEqual(scheduled, [180_000]);
  assert.equal(child.killCalls, 1);
});

test('WhisperService settles on excess stdout even when a killed child never closes', async () => {
  const child = fakeChild();
  const service = new WhisperService({
    scriptPath: 'C:/bridge/scripts/transcribe.py',
    spawn() {
      queueMicrotask(() => child.stdout.emit('data', Buffer.alloc(1024 * 1024 + 1)));
      return child;
    }
  });

  const error = await captureRejectionWithin(service.transcribe('C:/bridge/tmp/segment.wav'));
  assert.match(error.message, /exceeded 1 MiB/i);
  assert.equal(child.killCalls, 1);
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
