import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = path.resolve(HERE, '../public/mobile');

async function readAsset(name) {
  try {
    return await readFile(path.join(MOBILE_DIR, name), 'utf8');
  } catch (error) {
    assert.fail(`mobile web asset ${name} must exist: ${error.code ?? error.message}`);
  }
}

function idsIn(html) {
  return new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
}

test('mobile page ships a restrictive self-only policy without inline or third-party code', async () => {
  const html = await readAsset('index.html');
  const css = await readAsset('styles.css');

  const csp = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"/i)?.[1];
  assert.ok(csp, 'a CSP meta policy is required');
  for (const directive of [
    "default-src 'none'", "script-src 'self'", "style-src 'self'",
    "connect-src 'self'", "img-src 'self' data:", "font-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'"
  ]) {
    assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(html, /<script\s+src=["']\.\/app\.js["']\s+defer><\/script>/i);
  assert.match(html, /<link\s+rel=["']stylesheet["']\s+href=["']\.\/styles\.css["']>/i);
  assert.doesNotMatch(html, /<script(?!\s+src=)[^>]*>|\son[a-z]+\s*=|<style\b/i);
  assert.doesNotMatch(`${html}\n${css}`, /https?:\/\/|@import\b/i);
});

test('mobile page exposes labelled setup, status, transcripts, voice controls and safe exits', async () => {
  const html = await readAsset('index.html');
  const ids = idsIn(html);
  for (const id of [
    'token-panel', 'token-form', 'admin-token', 'token-error', 'dashboard',
    'refresh-button', 'reconfigure-button', 'clear-token-button', 'server-status',
    'server-time', 'device-count', 'device-list', 'empty-devices', 'voice-form',
    'voice', 'speed', 'speed-output', 'volume', 'volume-output', 'pitch',
    'pitch-output', 'voice-message', 'activity-status', 'apk-download'
  ]) {
    assert.ok(ids.has(id), `missing #${id}`);
  }

  assert.match(html, /lang=["']zh-CN["']/i);
  assert.match(html, /name=["']viewport["']/i);
  assert.match(html, /aria-live=["']polite["']/i);
  assert.match(html, /href=["']\/downloads\/xiaoli-control\.apk["']/i);
  for (const input of ['admin-token', 'voice', 'speed', 'volume', 'pitch']) {
    assert.match(html, new RegExp(`<label[^>]+for=["']${input}["']`, 'i'));
  }
});

test('mobile controller uses only the three same-origin API contracts with bearer auth', async () => {
  const script = await readAsset('app.js');

  assert.match(script, /['"]\/api\/mobile\/v1\/status['"]/);
  assert.match(script, /['"]\/api\/mobile\/v1\/voice['"]/);
  assert.match(script, /`\/api\/mobile\/v1\/devices\/\$\{encodeURIComponent\([^}]+\)\}\/mediate`/);
  assert.match(script, /Authorization:\s*`Bearer \$\{token\}`/);
  assert.match(script, /credentials:\s*['"]same-origin['"]/);
  assert.doesNotMatch(script, /https?:\/\//);
});

test('mobile controller keeps credentials private and renders remote data through textContent', async () => {
  const script = await readAsset('app.js');

  assert.match(script, /localStorage\.setItem\(TOKEN_STORAGE_KEY,\s*token\)/);
  assert.match(script, /localStorage\.removeItem\(TOKEN_STORAGE_KEY\)/);
  assert.match(script, /\.textContent\s*=/);
  assert.doesNotMatch(script, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|console\./);
  assert.doesNotMatch(script, /textContent\s*=\s*token|setAttribute\([^,]+,\s*token\)/);
});

test('mobile controller polls every two seconds without overlap and pauses when unfocused', async () => {
  const script = await readAsset('app.js');

  assert.match(script, /const\s+POLL_DELAY_MS\s*=\s*2_?000\s*;/);
  assert.match(script, /pollInFlight/);
  assert.match(script, /setTimeout\([^;]+POLL_DELAY_MS/s);
  assert.doesNotMatch(script, /setInterval\s*\(/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /['"]blur['"]/);
  assert.match(script, /['"]focus['"]/);
});

test('mediation requires an explicit confirmation before the encoded-device request', async () => {
  const script = await readAsset('app.js');
  const confirmation = script.search(/(?:window\.)?confirm\s*\(/);
  const request = script.search(/`\/api\/mobile\/v1\/devices\/\$\{encodeURIComponent\([^}]+\)\}\/mediate`/);

  assert.notEqual(confirmation, -1, 'missing mediation confirmation');
  assert.notEqual(request, -1, 'missing mediation request');
  assert.ok(confirmation < request, 'confirmation must happen before the mediation request');
});

test('fixed local TTS keeps the dashboard usable while disabling unsupported voice controls', async () => {
  const controller = await readAsset('app.js');
  assert.match(controller, /settings\.available === false/);
  assert.match(controller, /voice_settings_unavailable/);
  assert.match(controller, /setVoiceBusy\(true\)/);
});
