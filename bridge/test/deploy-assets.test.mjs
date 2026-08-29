import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(bridgeRoot, '..');

async function deploymentAsset(name) {
  return readFile(path.join(repositoryRoot, 'deploy', 'debian', name), 'utf8');
}

test('Debian deployment keeps durable state outside version-swapped releases', async () => {
  const [installer, unit, readme] = await Promise.all([
    deploymentAsset('install.sh'),
    deploymentAsset('xiaoli-bridge.service'),
    deploymentAsset('README.md')
  ]);

  assert.match(
    installer,
    /install -d --owner="\$\{SERVICE_USER\}" --group="\$\{SERVICE_USER\}" --mode=0700 "\$\{STATE_ROOT\}\/state"/
  );
  assert.match(installer, /BRIDGE_STATE_DIR=\/var\/lib\/xiaoli-bridge\/state/);
  assert.match(installer, /^# XFYUN_TTS_APP_ID=$/m);
  assert.match(installer, /^# XFYUN_TTS_API_KEY=$/m);
  assert.match(installer, /^# XFYUN_TTS_API_SECRET=$/m);
  assert.match(installer, /^# XFYUN_TTS_VOICE=x4_xiaoyan$/m);
  assert.match(installer, /^# MOBILE_ADMIN_TOKEN=$/m);
  assert.match(unit, /^Environment=BRIDGE_TEMP_DIR=\/var\/lib\/xiaoli-bridge\/tmp$/m);
  assert.match(unit, /^Environment=BRIDGE_STATE_DIR=\/var\/lib\/xiaoli-bridge\/state$/m);
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/env BRIDGE_HOST=127\.0\.0\.1 BRIDGE_MDNS_ENABLED=false BRIDGE_TEMP_DIR=\/var\/lib\/xiaoli-bridge\/tmp BRIDGE_STATE_DIR=\/var\/lib\/xiaoli-bridge\/state TMPDIR=\/var\/lib\/xiaoli-bridge\/tmp \/opt\/node\/bin\/node \/opt\/xiaoli-bridge\/src\/server\.mjs$/m
  );
  assert.match(
    unit,
    /^ReadWritePaths=\/var\/lib\/xiaoli-bridge\/tmp \/var\/lib\/xiaoli-bridge\/state$/m
  );
  assert.match(readme, /\/var\/lib\/xiaoli-bridge\/state/);
  assert.match(readme, /MOBILE_ADMIN_TOKEN/);
  assert.match(readme, /\/mobile\//);
  assert.doesNotMatch(installer, /rm -rf -- "\$\{STATE_ROOT\}/);
  assert.match(installer, /rsync[^\n]*--exclude='state'(?:\s|$)/);
});

test('local runtime directories containing audio and transcripts are ignored by Git', async () => {
  const gitignore = await readFile(path.join(bridgeRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /^tmp\/$/m);
  assert.match(gitignore, /^state\/$/m);
});
