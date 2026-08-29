import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMobileApi} from './mobile-api.mjs';
import {createMobileHandler} from './mobile-handler.mjs';
import {VoiceSettingsStore} from './voice-settings-store.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(MODULE_DIR, '../../public/mobile');
const DEFAULT_APK_PATH = path.resolve(
  MODULE_DIR, '../../public/downloads/xiaoli-control.apk');

export async function createMobileRuntime({
  adminToken,
  controlPlane,
  ttsService,
  stateDir,
  voiceSettingsStore,
  publicDir = DEFAULT_PUBLIC_DIR,
  apkPath = DEFAULT_APK_PATH,
  now
} = {}) {
  if (adminToken === null || adminToken === undefined || adminToken === '') {
    return {enabled: false, handler: null};
  }
  const voiceConfigurable = typeof ttsService?.getVoiceSettings === 'function' &&
    typeof ttsService?.updateVoiceSettings === 'function';
  let store = null;
  if (voiceConfigurable) {
    store = voiceSettingsStore ?? new VoiceSettingsStore({stateDir});
    if (typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('mobile runtime requires a voice settings store');
    }
    const savedSettings = await store.load();
    if (savedSettings !== null) await ttsService.updateVoiceSettings(savedSettings);
  }

  const api = createMobileApi({
    adminToken,
    controlPlane,
    ttsService,
    voiceSettingsStore: store,
    ...(now ? {now} : {})
  });
  const handler = createMobileHandler({api, publicDir, apkPath});
  return {enabled: true, handler, api, voiceSettingsStore: store};
}
