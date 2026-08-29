import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerUrlPolicy, isApkDownload } from '../src/serverUrlPolicy';

test('canonicalizes an HTTPS origin and discards path, query, and fragment', () => {
  const policy = createServerUrlPolicy('  HTTPS://Example.COM:443/setup?q=1#part  ');
  assert.equal(policy.origin, 'https://example.com');
  assert.equal(policy.dashboardUrl, 'https://example.com/mobile/');
  assert.equal(policy.host, 'example.com');
  assert.equal(policy.effectivePort, 443);
});

test('keeps a non-default port', () => {
  const policy = createServerUrlPolicy('https://Bridge.Example:8443/path');
  assert.equal(policy.origin, 'https://bridge.example:8443');
  assert.equal(policy.dashboardUrl, 'https://bridge.example:8443/mobile/');
});

test('allows only the exact HTTPS origin', () => {
  const policy = createServerUrlPolicy('https://bridge.example');
  assert.equal(policy.isAllowedNavigation('https://bridge.example/mobile/'), true);
  assert.equal(policy.isAllowedNavigation('https://BRIDGE.example:443/api/mobile/v1/status'), true);
  assert.equal(policy.isAllowedNavigation('https://bridge.example.evil.test/mobile/'), false);
  assert.equal(policy.isAllowedNavigation('https://evil.test/?next=https://bridge.example'), false);
  assert.equal(policy.isAllowedNavigation('http://bridge.example/mobile/'), false);
  assert.equal(policy.isAllowedNavigation('https://bridge.example:8443/mobile/'), false);
  assert.equal(policy.isAllowedNavigation('https://user@bridge.example/mobile/'), false);
});

test('rejects invalid or unsafe configuration addresses', () => {
  const invalid = [
    '',
    'example.com',
    'http://example.com',
    'file:///tmp/index.html',
    'content://settings',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'https://@example.com',
    'https://example.com:',
    'https://example.com:0',
    'https://example.com:65536',
    'https:\\example.com',
    'https://example.com\u0000.evil.test',
  ];

  for (const candidate of invalid) {
    assert.throws(() => createServerUrlPolicy(candidate), /valid HTTPS/, candidate);
  }
});

test('malformed navigation candidates return false instead of throwing', () => {
  const policy = createServerUrlPolicy('https://bridge.example');
  for (const candidate of ['', 'not a URL', 'data:text/html,hello', 'https://bridge.example:']) {
    assert.doesNotThrow(() => policy.isAllowedNavigation(candidate));
    assert.equal(policy.isAllowedNavigation(candidate), false);
  }
});

test('recognizes APK downloads by parsed path', () => {
  assert.equal(isApkDownload('https://bridge.example/downloads/xiaoli-control.apk'), true);
  assert.equal(isApkDownload('https://bridge.example/downloads/APP.APK?version=2'), true);
  assert.equal(isApkDownload('https://bridge.example/mobile/'), false);
  assert.equal(isApkDownload('not a URL'), false);
});
