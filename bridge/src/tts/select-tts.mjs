import {EspeakTts} from './espeak-tts.mjs';
import {ResilientTts} from './resilient-tts.mjs';
import {WindowsTts} from './windows-tts.mjs';
import {XfyunTts} from './xfyun-tts.mjs';

export function selectTts({
  provider,
  platform = process.platform,
  xfyun,
  WindowsTtsClass = WindowsTts,
  EspeakTtsClass = EspeakTts,
  XfyunTtsClass = XfyunTts,
  ResilientTtsClass = ResilientTts
} = {}) {
  const selected = typeof provider === 'string' && provider.trim() !== ''
    ? provider
    : (platform === 'win32' ? 'windows' : 'espeak-ng');
  if (selected === 'windows') return new WindowsTtsClass();
  if (selected === 'espeak-ng') return new EspeakTtsClass();
  if (selected === 'xfyun') {
    if (!xfyun || typeof xfyun !== 'object') {
      throw new Error('Xfyun TTS configuration is required');
    }
    const fallback = platform === 'win32'
      ? new WindowsTtsClass()
      : new EspeakTtsClass();
    return new ResilientTtsClass({
      primary: new XfyunTtsClass(xfyun),
      fallback
    });
  }
  throw new Error('TTS_PROVIDER must be windows, espeak-ng, or xfyun');
}
