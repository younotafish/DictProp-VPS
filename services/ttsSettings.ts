import { TTS_VOICE } from './api';

export type TtsStyle = 'clear' | 'casual';
const CASUAL_TOKEN = 'casual';
const TTS_STYLE_KEY = 'tts_style';
let style: TtsStyle = typeof localStorage !== 'undefined' && localStorage.getItem(TTS_STYLE_KEY) === 'casual' ? 'casual' : 'clear';
const styleListeners = new Set<(value: TtsStyle) => void>();

export const getTtsStyle = () => style;
export const getTtsStyleToken = () => style === 'casual' ? CASUAL_TOKEN : TTS_VOICE;
export const subscribeTtsStyle = (callback: (value: TtsStyle) => void) => {
  styleListeners.add(callback);
  callback(style);
  return () => { styleListeners.delete(callback); };
};
export const setTtsStyle = (value: TtsStyle) => {
  if (value === style) return;
  style = value;
  try { localStorage.setItem(TTS_STYLE_KEY, value); } catch { /* best effort */ }
  styleListeners.forEach(callback => callback(value));
};

export const RATE_PRESETS = [1.0, 1.1, 1.3, 1.5, 1.75, 2.0] as const;
const RATE_KEY = 'tts_rate';
const clampRate = (value: number) => Math.min(2, Math.max(1, value));
let rate = (() => {
  try {
    const value = Number(localStorage.getItem(RATE_KEY));
    return Number.isFinite(value) && value > 0 ? clampRate(value) : 1.1;
  } catch { return 1.1; }
})();
const rateListeners = new Set<(value: number) => void>();
export const getPlaybackRate = () => rate;
export const subscribePlaybackRate = (callback: (value: number) => void) => {
  rateListeners.add(callback);
  callback(rate);
  return () => { rateListeners.delete(callback); };
};
export const setPlaybackRate = (value: number) => {
  const next = clampRate(value);
  if (next === rate) return;
  rate = next;
  try { localStorage.setItem(RATE_KEY, String(next)); } catch { /* best effort */ }
  rateListeners.forEach(callback => callback(next));
};
