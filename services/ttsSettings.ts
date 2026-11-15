// ── Speech style: clear (crisp MiMo) ⇄ casual (reduced, mumbled) ──────────────
// A persisted GLOBAL choice of which cached track to play. Every play site routes through this engine,
// so the one toggle governs word review, sentence review, and the global-search popup at once. Each
// style's cache voice tokens are in services/audio/voices.ts; both styles' clips have word timings.
export type TtsStyle = 'clear' | 'casual';
const TTS_STYLE_KEY = 'tts_style';
// Read like the rate below: with storage blocked, touching localStorage throws, and this runs on import.
let style: TtsStyle = (() => {
  try { return localStorage.getItem(TTS_STYLE_KEY) === 'casual' ? 'casual' : 'clear'; } catch { return 'clear'; }
})();
const styleListeners = new Set<(value: TtsStyle) => void>();

export const getTtsStyle = () => style;
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

// ── Playback speed: adjustable voice rate for example sentences ────────────────
// A persisted GLOBAL playback rate for the cached-clip (<audio>) path — i.e. the example-sentence
// voice. Cached clips should play at their authored rate by default, so the default is 1.0×; it's
// adjustable up to 2×. Applied at the one shared <audio> element (see playUrl) with preservesPitch,
// so a faster rate speeds up the speech WITHOUT raising the pitch. Like the style toggle, it's a
// single global value routed through this engine, so one control governs word review, sentence
// review, and the search popup at once. Word reads (speakWord → system voice) are left at their own
// natural rate — the complaint is sentence playback.
export const RATE_PRESETS = [1.0, 1.1, 1.3, 1.5, 1.75, 2.0] as const;
const DEFAULT_RATE = 1.0;
const RATE_KEY = 'tts_rate';
const clampRate = (value: number) => Math.min(2, Math.max(1, value));
let rate = (() => {
  try {
    const value = Number(localStorage.getItem(RATE_KEY));
    return Number.isFinite(value) && value > 0 ? clampRate(value) : DEFAULT_RATE;
  } catch { return DEFAULT_RATE; }
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
