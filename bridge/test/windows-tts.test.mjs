import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
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
