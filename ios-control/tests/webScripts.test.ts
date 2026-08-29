import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLEAR_SITE_DATA_MESSAGE,
  CLEAR_SITE_DATA_SCRIPT,
  HIDE_APK_LINKS_SCRIPT,
} from '../src/webScripts';

test('site data script clears browser storage, cookies, and acknowledges completion', () => {
  assert.match(CLEAR_SITE_DATA_SCRIPT, /localStorage\.clear/);
  assert.match(CLEAR_SITE_DATA_SCRIPT, /sessionStorage\.clear/);
  assert.match(CLEAR_SITE_DATA_SCRIPT, /document\.cookie/);
  assert.match(CLEAR_SITE_DATA_SCRIPT, new RegExp(CLEAR_SITE_DATA_MESSAGE));
});

test('iOS script removes APK anchors and observes later DOM changes', () => {
  assert.match(HIDE_APK_LINKS_SCRIPT, /querySelectorAll\('a\[href\]'\)/);
  assert.match(HIDE_APK_LINKS_SCRIPT, /\\\.apk/);
  assert.match(HIDE_APK_LINKS_SCRIPT, /MutationObserver/);
});
