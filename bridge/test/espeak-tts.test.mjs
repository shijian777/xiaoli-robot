import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import test from 'node:test';
import {EspeakTts} from '../src/tts/espeak-tts.mjs';

function child() {
  const process = new EventEmitter();
  process.stdin = new EventEmitter();
  process.stdin.writes = [];
  process.stdin.write = (value) => process.stdin.writes.push(Buffer.from(value));
  process.stdin.end = () => { process.stdin.ended = true; };
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.killCalls = 0;
  process.killSignals = [];
  process.kill = (signal) => {
    process.killCalls += 1;
    process.killSignals.push(signal);
    return true;
  };
  return process;
}

function clock() {
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

test('EspeakTts sends mediation text through espeak stdin and returns raw 16 kHz mono s16le PCM', async () => {
  const espeak = child();
  const ffmpeg = child();
  const spawned = [];
  const removed = [];
  const pcm = Buffer.from([1, 0, 2, 0]);
  const tts = new EspeakTts({
    tempDir: '/tmp',
    spawn(command, args, options) {
      spawned.push({command, args, options});
      return spawned.length === 1 ? espeak : ffmpeg;
    },
    fs: {
      async mkdtemp() { return '/tmp/xiaoli-espeak-test'; },
      async writeFile(candidate, contents) {
        assert.equal(candidate, path.join('/tmp/xiaoli-espeak-test', 'speech.wav'));
        assert.deepEqual(contents, Buffer.from('WAV'));
      },
      async rm(candidate) { removed.push(candidate); }
    }
  });

  const result = tts.synthesize('调解文字');
  await new Promise((resolve) => setImmediate(resolve));
  espeak.stdout.emit('data', Buffer.from('WAV'));
  espeak.emit('close', 0);
  await new Promise((resolve) => setImmediate(resolve));
  ffmpeg.stdout.emit('data', pcm);
  ffmpeg.emit('close', 0);

  assert.deepEqual(await result, pcm);
  assert.deepEqual(espeak.stdin.writes, [Buffer.from('调解文字')]);
  assert.equal(espeak.stdin.ended, true);
  assert.deepEqual(spawned[0], {
    command: 'espeak-ng', args: ['-v', 'cmn', '--stdin', '--stdout'], options: {shell: false, windowsHide: true}
  });
  assert.ok(!spawned[0].args.includes('调解文字'));
  assert.deepEqual(spawned[1], {
    command: 'ffmpeg',
    args: ['-hide_banner', '-loglevel', 'error', '-i', path.join('/tmp/xiaoli-espeak-test', 'speech.wav'), '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1'],
    options: {shell: false, windowsHide: true}
  });
  assert.deepEqual(removed, [path.join('/tmp/xiaoli-espeak-test', 'speech.wav'), '/tmp/xiaoli-espeak-test']);
});

test('EspeakTts rejects blank text before starting a process', async () => {
  let spawned = false;
  const tts = new EspeakTts({spawn() { spawned = true; }});
  await assert.rejects(() => tts.synthesize('   '), /non-empty string/);
  assert.equal(spawned, false);
});

test('EspeakTts escalates a timed-out no-close process to SIGKILL and defers cleanup until it closes', async () => {
  const espeak = child();
  const removed = [];
  const timers = clock();
  const tts = new EspeakTts({
    tempDir: '/tmp', spawn() { return espeak; },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    fs: {
      async mkdtemp() { return '/tmp/xiaoli-espeak-timeout'; },
      async writeFile() { throw new Error('must not write after timeout'); },
      async rm(candidate) { removed.push(candidate); }
    }
  });

  const pending = tts.synthesize('timeout');
  await new Promise((resolve) => setImmediate(resolve));
  timers.timers[0].callback();
  assert.deepEqual(espeak.killSignals, [undefined]);
  assert.deepEqual(removed, []);
  timers.timers[1].callback();
  assert.deepEqual(espeak.killSignals, [undefined, 'SIGKILL']);
  timers.timers[2].callback();
  await assert.rejects(pending, /Espeak TTS synthesis timed out/);
  assert.equal(espeak.killCalls, 2);
  assert.deepEqual(removed, []);
  espeak.emit('close', 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, [path.join('/tmp/xiaoli-espeak-timeout', 'speech.wav'), '/tmp/xiaoli-espeak-timeout']);
});

test('EspeakTts honors caller abort and cleans its temporary files', async () => {
  const espeak = child();
  const removed = [];
  const controller = new AbortController();
  const tts = new EspeakTts({
    tempDir: '/tmp', spawn() { return espeak; },
    fs: {
      async mkdtemp() { return '/tmp/xiaoli-espeak-abort'; },
      async writeFile() { throw new Error('must not write after abort'); },
      async rm(candidate) { removed.push(candidate); }
    }
  });

  const pending = tts.synthesize('cancel', {signal: controller.signal});
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  espeak.emit('close', 1);
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(espeak.killCalls, 1);
  assert.deepEqual(removed, [path.join('/tmp/xiaoli-espeak-abort', 'speech.wav'), '/tmp/xiaoli-espeak-abort']);
});
