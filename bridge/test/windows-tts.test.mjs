import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {parsePcmWav} from '../src/audio/wav.mjs';
import {WindowsTts} from '../src/tts/windows-tts.mjs';

const execFileAsync = promisify(execFile);
const text = '小理开始调解。';
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const scriptPath = path.resolve('scripts/synthesize.ps1');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4321;
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
  throw new Error('Windows TTS did not schedule its timeout');
}

test('Windows TTS synthesizes Chinese as 16 kHz mono PCM without a RIFF service header', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'xiaoli-windows-tts-'));
  const wavPath = path.join(directory, 'smoke.wav');
  try {
    await execFileAsync(powershell, [
      '-Sta',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Text', text,
      '-OutputPath', wavPath
    ], {shell: false, windowsHide: true, timeout: 90_000});

    const wav = await readFile(wavPath);
    const parsed = parsePcmWav(wav);
    assert.equal(parsed.sampleRate, 16000);
    assert.equal(parsed.bits, 16);
    assert.equal(parsed.channels, 1);
    assert.ok(parsed.pcm.length > 3200);

    const pcm = await new WindowsTts().synthesize(text);
    assert.ok(pcm.length > 3200);
    assert.notEqual(pcm.subarray(0, 4).toString('ascii'), 'RIFF');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('Windows TTS waits for a killed child to close before cleaning up a timed-out synthesis', async () => {
  const child = fakeChild();
  const clock = scheduledTimers();
  const cleanup = [];
  const tts = new WindowsTts({
    tempDir: tmpdir(),
    spawn() { return child; },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fs: {
      async mkdtemp() { return 'C:/tmp/xiaoli-tts-test'; },
      async readFile() { throw new Error('readFile must not run after timeout'); },
      async rm(candidate) { cleanup.push(candidate); }
    }
  });

  const pending = tts.synthesize('timeout');
  await waitForFirstTimer(clock);
  clock.timers[0].callback();
  await flush();
  assert.equal(child.killCalls, 1);
  assert.deepEqual(cleanup, []);

  child.emit('close', 1, null);
  await assert.rejects(pending, /Windows TTS synthesis timed out/);
  assert.deepEqual(cleanup, [path.join('C:/tmp/xiaoli-tts-test', 'speech.wav'), 'C:/tmp/xiaoli-tts-test']);
});

test('Windows TTS force-terminates a no-close child, settles the timeout, and cleans exactly once after a later close', async () => {
  const child = fakeChild();
  const taskkill = fakeChild();
  const clock = scheduledTimers();
  const cleanup = [];
  const spawned = [];
  const tts = new WindowsTts({
    tempDir: tmpdir(),
    spawn(command, args, options) {
      spawned.push({command, args, options});
      return command === 'taskkill' ? taskkill : child;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fs: {
      async mkdtemp() { return 'C:/tmp/xiaoli-tts-test'; },
      async readFile() { throw new Error('readFile must not run after timeout'); },
      async rm(candidate) { cleanup.push(candidate); }
    }
  });

  const pending = tts.synthesize('timeout');
  await waitForFirstTimer(clock);
  clock.timers[0].callback();
  assert.doesNotThrow(() => child.emit('error', new Error('late kill error')));
  assert.ok(Number.isFinite(clock.timers[1].milliseconds));
  assert.ok(clock.timers[1].milliseconds > 0);
  clock.timers[1].callback();
  assert.deepEqual(spawned[1], {
    command: 'taskkill',
    args: ['/PID', '4321', '/T', '/F'],
    options: {shell: false, windowsHide: true}
  });
  assert.deepEqual(cleanup, []);
  clock.timers[2].callback();
  await assert.rejects(pending, /Windows TTS synthesis timed out/);
  assert.deepEqual(cleanup, []);
  assert.doesNotThrow(() => child.emit('error', new Error('late error after grace')));
  child.emit('close', 1, null);
  await flush();
  assert.deepEqual(cleanup, [path.join('C:/tmp/xiaoli-tts-test', 'speech.wav'), 'C:/tmp/xiaoli-tts-test']);
  child.emit('close', 1, null);
  await flush();
  assert.deepEqual(cleanup, [path.join('C:/tmp/xiaoli-tts-test', 'speech.wav'), 'C:/tmp/xiaoli-tts-test']);
});

test('Windows TTS retries a locked WAV cleanup without skipping temporary-directory cleanup', async () => {
  const child = fakeChild();
  const clock = scheduledTimers();
  const cleanup = [];
  let wavAttempts = 0;
  const tts = new WindowsTts({
    tempDir: tmpdir(),
    spawn() { return child; },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fs: {
      async mkdtemp() { return 'C:/tmp/xiaoli-tts-test'; },
      async readFile() { throw new Error('readFile must not run after timeout'); },
      async rm(candidate) {
        cleanup.push(candidate);
        if (candidate.endsWith('speech.wav') && ++wavAttempts === 1) {
          throw Object.assign(new Error('locked'), {code: 'EBUSY'});
        }
      }
    }
  });

  const pending = tts.synthesize('timeout');
  await waitForFirstTimer(clock);
  clock.timers[0].callback();
  child.emit('close', 1, null);
  await flush();
  clock.timers[2].callback();
  await assert.rejects(pending, /Windows TTS synthesis timed out/);
  assert.deepEqual(cleanup, [
    path.join('C:/tmp/xiaoli-tts-test', 'speech.wav'),
    'C:/tmp/xiaoli-tts-test',
    path.join('C:/tmp/xiaoli-tts-test', 'speech.wav')
  ]);
});

test('Windows TTS stops its child and settles when it closes during caller-abort grace', async () => {
  const child = fakeChild();
  const taskkill = fakeChild();
  const spawned = [];
  const cleanup = [];
  const controller = new AbortController();
  const tts = new WindowsTts({
    spawn(command, args, options) {
      spawned.push({command, args, options});
      return command === 'taskkill' ? taskkill : child;
    },
    fs: {
      async mkdtemp() { return 'C:/tmp/xiaoli-tts-cancel'; },
      async readFile() { throw new Error('cancelled synthesis must not read output'); },
      async rm(candidate) { cleanup.push(candidate); }
    }
  });

  const pending = tts.synthesize('cancel me', {signal: controller.signal});
  await flush();
  controller.abort();
  child.emit('close', 1, null);
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(child.killCalls, 1);
  assert.equal(spawned.length, 1);
  assert.deepEqual(cleanup, [path.join('C:/tmp/xiaoli-tts-cancel', 'speech.wav'), 'C:/tmp/xiaoli-tts-cancel']);
});

test('Windows TTS settles caller abort after bounded no-close termination without premature cleanup', async () => {
  const child = fakeChild();
  const taskkill = fakeChild();
  const clock = scheduledTimers();
  const spawned = [];
  const cleanup = [];
  const controller = new AbortController();
  const tts = new WindowsTts({
    spawn(command, args, options) {
      spawned.push({command, args, options});
      return command === 'taskkill' ? taskkill : child;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fs: {
      async mkdtemp() { return 'C:/tmp/xiaoli-tts-cancel-no-close'; },
      async readFile() { throw new Error('cancelled synthesis must not read output'); },
      async rm(candidate) { cleanup.push(candidate); }
    }
  });

  const pending = tts.synthesize('cancel without close', {signal: controller.signal});
  await waitForFirstTimer(clock);
  controller.abort();
  assert.equal(child.killCalls, 1);
  assert.deepEqual(cleanup, []);
  assert.ok(clock.timers[1].milliseconds > 0);
  clock.timers[1].callback();
  assert.deepEqual(spawned[1], {
    command: 'taskkill',
    args: ['/PID', '4321', '/T', '/F'],
    options: {shell: false, windowsHide: true}
  });
  assert.deepEqual(cleanup, []);
  assert.ok(clock.timers[2].milliseconds > 0);
  clock.timers[2].callback();

  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(cleanup, []);
});

test('Windows TTS performs deferred caller-abort cleanup exactly once after a late close', async () => {
  const child = fakeChild();
  const taskkill = fakeChild();
  const clock = scheduledTimers();
  const cleanup = [];
  const controller = new AbortController();
  const tts = new WindowsTts({
    spawn(command) { return command === 'taskkill' ? taskkill : child; },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fs: {
      async mkdtemp() { return 'C:/tmp/xiaoli-tts-cancel-late-close'; },
      async readFile() { throw new Error('cancelled synthesis must not read output'); },
      async rm(candidate) { cleanup.push(candidate); }
    }
  });

  const pending = tts.synthesize('cancel then close late', {signal: controller.signal});
  await waitForFirstTimer(clock);
  controller.abort();
  clock.timers[1].callback();
  clock.timers[2].callback();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(cleanup, []);

  child.emit('close', 1, null);
  await flush();
  assert.deepEqual(cleanup, [
    path.join('C:/tmp/xiaoli-tts-cancel-late-close', 'speech.wav'),
    'C:/tmp/xiaoli-tts-cancel-late-close'
  ]);
  child.emit('close', 1, null);
  await flush();
  assert.equal(cleanup.length, 2);
});
