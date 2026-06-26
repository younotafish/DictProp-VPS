/**
 * In-browser neural TTS (Kokoro-82M via kokoro-js / Transformers.js).
 *
 * Produces a natural voice that runs 100% on-device — zero network roundtrip after a
 * one-time model download (fetched from the Hugging Face CDN into the browser's Cache
 * Storage, so it works offline afterward and never touches our server).
 *
 * Engine policy (see pickEngines / speakNatural) — always fp32, the only clean precision:
 *  - Chromium + WebGPU -> Kokoro on the WebGPU backend (fp32). Fast.
 *  - Everything else   -> Kokoro on the WASM/CPU backend (fp32). Works on Safari, iOS/iPadOS,
 *                         and any browser with WebAssembly — CPU-bound so slower (seconds per
 *                         sentence on a phone), but the audio is clean.
 *  - WebGPU load fails -> automatically retried on WASM before giving up.
 *  - All engines fail  -> fall back to the system Web Speech voice (services/speech.ts).
 *
 * Why not WebGPU on Safari/iOS? Safari exposes navigator.gpu (iOS/iPadOS/macOS 26+) but
 * onnxruntime-web's WebGPU backend is unreliable there, so Apple devices use WASM.
 *
 * The model is only ever downloaded on a *deliberate* speaker-button click
 * (allowDownload: true). Automatic/navigation speech passes allowDownload: false, so it
 * upgrades to the natural voice once the model is already resident but never triggers a
 * download on its own.
 */
import { speak as systemSpeak } from './speech';
import { stripSentenceMarkers } from '../components/HighlightedSentence';
import { ttsKey, fetchCachedTTS, fetchCachedTTSTimings, requestTTSGeneration, TTS_VOICE, type WordTiming } from './api';
import { log, warn } from './logger';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// An execution backend. dtype is fp32 on BOTH — it's the only precision that produces clean audio
// for this model. Hard-won, confirmed on real devices: q8 → "radio static"/garbled and fp16 → static
// on *every* backend (the int8/fp16 weights are lossy for Kokoro), not just on WebGPU. fp32 costs a
// ~326 MB download (vs ~86 MB for q8) and is CPU-bound on WASM, but a correct slow voice beats a
// fast broken one.
interface Engine {
  device: 'webgpu' | 'wasm';
  dtype: 'fp32'; // fp32 only — q8/fp16 sound like radio static on every backend (see above).
}
const WEBGPU_ENGINE: Engine = { device: 'webgpu', dtype: 'fp32' };
const WASM_ENGINE: Engine = { device: 'wasm', dtype: 'fp32' };

export const DEFAULT_VOICE = 'af_heart'; // Kokoro fallback voice — American female (matches our GA/rhotic IPA)
// MiMo voice for the server-cached PRIMARY TTS comes from api.ts (TTS_VOICE) — single source of truth.

// ── Speech style: clear (crisp MiMo) ⇄ casual (reduced, mumbled) ──────────────
// A persisted GLOBAL choice of which cached track to play. Every play site routes through this engine,
// so the one toggle governs word review, sentence review, and the global-search popup at once. The
// style maps to the cache "voice" token: clear -> TTS_VOICE (e.g. 'Mia'); casual -> 'casual' (MUST
// match the server's CASUAL_STYLE). Casual clips are audio-only — no word timings / lead-in skip.
export type TtsStyle = 'clear' | 'casual';
const CASUAL_TOKEN = 'casual';
const TTS_STYLE_KEY = 'tts_style';
let ttsStyle: TtsStyle =
  (typeof localStorage !== 'undefined' && localStorage.getItem(TTS_STYLE_KEY) === 'casual') ? 'casual' : 'clear';
const styleListeners = new Set<(s: TtsStyle) => void>();
const styleToken = (): string => (ttsStyle === 'casual' ? CASUAL_TOKEN : TTS_VOICE);

export const getTtsStyle = (): TtsStyle => ttsStyle;
export const subscribeTtsStyle = (cb: (s: TtsStyle) => void): (() => void) => {
  styleListeners.add(cb);
  cb(ttsStyle);
  return () => { styleListeners.delete(cb); };
};
export const setTtsStyle = (s: TtsStyle): void => {
  if (s === ttsStyle) return;
  ttsStyle = s;
  try { localStorage.setItem(TTS_STYLE_KEY, s); } catch { /* ignore */ }
  stopCurrent(); // stop the in-flight clip so the next play uses the newly-chosen track
  styleListeners.forEach((cb) => { try { cb(s); } catch { /* ignore */ } });
};

// Tiny valid silent WAV — played once inside a user gesture to unlock <audio> on iOS Safari,
// so a later play() after the async synth await isn't blocked as non-user-initiated.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

const CONSENT_KEY = 'tts_neural_consent'; // mobile one-time download consent

type KokoroModule = typeof import('kokoro-js');
type KokoroInstance = InstanceType<KokoroModule['KokoroTTS']>;

// ---------------------------------------------------------------------------
// Status (optional global indicator)
// ---------------------------------------------------------------------------
export type TtsStatus = 'idle' | 'loading' | 'ready' | 'error';
let status: TtsStatus = 'idle';
let progress = 0; // 0..1 during the one-time download
const listeners = new Set<(status: TtsStatus, progress: number) => void>();

const emit = () => listeners.forEach((cb) => cb(status, progress));
const setStatus = (s: TtsStatus, p?: number) => {
  status = s;
  if (p !== undefined) progress = p;
  emit();
};

/** Subscribe to model status/progress. Fires immediately with the current value. */
export const subscribe = (cb: (status: TtsStatus, progress: number) => void): (() => void) => {
  listeners.add(cb);
  cb(status, progress);
  return () => listeners.delete(cb);
};
export const getStatus = (): TtsStatus => status;
export const isModelReady = (): boolean => status === 'ready';

// ---------------------------------------------------------------------------
// Capability gate
// ---------------------------------------------------------------------------
/** navigator.userAgentData only exists on Chromium — our proxy for "WebGPU is reliable here". */
const isChromium = (): boolean =>
  typeof navigator !== 'undefined' && !!(navigator as any).userAgentData;

/**
 * WebGPU is only reliable through onnxruntime-web on Chromium. Safari exposes navigator.gpu
 * (iOS/iPadOS/macOS 26+) but its WebGPU breaks our ONNX runtime, so we keep Apple on WASM.
 */
const canUseWebGPU = (): boolean =>
  typeof navigator !== 'undefined' && !!(navigator as any).gpu && isChromium();

/** Engines to try, best-first. WebGPU-capable devices fall back to WASM if WebGPU load fails. */
const pickEngines = (): Engine[] => (canUseWebGPU() ? [WEBGPU_ENGINE, WASM_ENGINE] : [WASM_ENGINE]);

/**
 * True when the device can run Kokoro at all. WASM runs anywhere with WebAssembly (every modern
 * browser, including iOS/iPadOS Safari), so neural is broadly supported — it uses the GPU when it
 * can and the CPU otherwise.
 */
export const isNeuralSupported = (): boolean =>
  typeof navigator !== 'undefined' && typeof WebAssembly !== 'undefined';

const isMobile = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)); // iPadOS

/**
 * iOS / iPadOS — where in-browser Kokoro is impractical (no big download / slow WASM). These devices
 * use the system Web Speech voice as the cache-miss fallback and never download the Kokoro model.
 * Catches iPadOS Safari masquerading as Mac (platform 'MacIntel' + touch).
 */
const isIOS = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

const hasConsent = (): boolean => {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
};

/** On mobile, confirm the one-time ~330 MB (fp32) download before pulling it (respect cellular data). */
const confirmDownloadIfNeeded = (): boolean => {
  if (!isMobile() || hasConsent()) return true;
  const ok =
    typeof window !== 'undefined' &&
    window.confirm(
      'Download the natural voice? About 330 MB, one-time. After that it works offline with no further data.',
    );
  if (ok) {
    try {
      localStorage.setItem(CONSENT_KEY, '1');
    } catch {
      /* ignore */
    }
  }
  return !!ok;
};

// ---------------------------------------------------------------------------
// Model + synthesis
// ---------------------------------------------------------------------------
let modelPromise: Promise<KokoroInstance> | null = null;

const loadModel = async (engine: Engine): Promise<KokoroInstance> => {
  const { KokoroTTS } = await import('kokoro-js');
  // Skip the local /models/* lookup (404s) — load straight from the HF Hub + browser cache.
  // Non-fatal: a direct import of the (transitive) transformers dep shouldn't fail the load.
  try {
    const transformers: any = await import('@huggingface/transformers');
    transformers.env.allowLocalModels = false;
  } catch {
    /* ignore */
  }
  return KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: engine.dtype as any,
    device: engine.device as any,
    progress_callback: (p: any) => {
      if (p && p.status === 'progress' && typeof p.progress === 'number') {
        setStatus('loading', Math.max(0, Math.min(1, p.progress / 100)));
      }
    },
  });
};

// Try each engine once (WebGPU then WASM on Chromium; WASM on Apple). We deliberately DON'T retry
// in a tight loop here: the fp32 model is ~326 MB and a failed fetch isn't cached, so an immediate
// retry just re-downloads it — wasteful, especially on mobile. Transient flakes are instead healed
// by spaced, backed-off retries in preloadNeural() (and by the next deliberate play). On failure we
// reset modelPromise so the next attempt starts clean — no session lockout, no hard-refresh needed.
// A fully-downloaded file is cached, so any later attempt loads from cache instantly.
const ensureModel = (): Promise<KokoroInstance> => {
  if (modelPromise) return modelPromise;
  setStatus('loading', 0);
  modelPromise = (async () => {
    let lastErr: unknown;
    for (const engine of pickEngines()) {
      try {
        const tts = await loadModel(engine);
        log(`🔊 Neural TTS: Kokoro model ready (${engine.dtype}, ${engine.device})`);
        setStatus('ready', 1);
        return tts;
      } catch (e) {
        lastErr = e;
        warn(`🔊 Neural TTS: ${engine.device} load failed`, e);
        setStatus('loading', 0);
      }
    }
    throw lastErr;
  })();
  modelPromise.catch(() => {
    modelPromise = null; // allow a fresh attempt on the next play / preload retry
    setStatus('error');
  });
  return modelPromise;
};

/**
 * Proactively download + initialize the model in the background so the first play (or autoplay) is
 * instant. Because the ~326 MB fp32 fetch can fail partway on a flaky link, this RETRIES with
 * backoff instead of giving up for the session — giving up was what used to force a manual
 * hard-refresh to get the natural voice. A successful load clears the budget; an `online` event
 * starts a fresh round. No-ops without WebAssembly, while a load is in flight / already done, once
 * the retry budget is spent, or (on mobile) before the one-time download is consented to.
 */
const MAX_WARM_ROUNDS = 3;
let warmRounds = 0;
let warmTimer: ReturnType<typeof setTimeout> | null = null;

export const preloadNeural = (): void => {
  if (!isNeuralSupported()) return;                       // no WebAssembly at all → system-voice path
  if (isIOS()) return;                                    // iPhone/iPad use cached MiMo + Web Speech; never download Kokoro
  if (isMobile() && !hasConsent()) return;                // wait for consent before a big mobile download
  if (status === 'loading' || status === 'ready') return; // in flight or already warm
  if (warmRounds >= MAX_WARM_ROUNDS) return;              // spent the budget; wait for `online` to reset
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
  log(`🔊 Neural TTS: warming model in the background (round ${warmRounds + 1}/${MAX_WARM_ROUNDS})`);
  ensureModel().then(
    () => { warmRounds = 0; },
    () => {
      warmRounds++;
      if (warmRounds >= MAX_WARM_ROUNDS) return;
      const delay = Math.min(30000, 4000 * 2 ** (warmRounds - 1)); // 4s, 8s, 16s
      warmTimer = setTimeout(() => { warmTimer = null; preloadNeural(); }, delay);
    },
  );
};

// A restored connection is the best moment to try again from scratch — reset the budget and re-warm.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { warmRounds = 0; preloadNeural(); });
}

const audioCache = new Map<string, string>(); // `${voice}:${text}` -> object URL

const synthesize = async (text: string, voice: string): Promise<string> => {
  const key = `${voice}:${text}`;
  const cached = audioCache.get(key);
  if (cached) return cached;
  const tts = await ensureModel();
  const audio = await tts.generate(text, { voice: voice as any });
  const url = URL.createObjectURL(audio.toBlob());
  audioCache.set(key, url);
  return url;
};

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
let audioEl: HTMLAudioElement | null = null;
let audioUnlocked = false;

const getAudioEl = (): HTMLAudioElement => {
  if (!audioEl) audioEl = new Audio();
  return audioEl;
};

/** Play a silent clip inside the click gesture so iOS lets us play the real audio later. */
const unlockAudio = (): void => {
  if (audioUnlocked) return;
  try {
    const el = getAudioEl();
    el.src = SILENT_WAV;
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        audioUnlocked = true;
      }).catch(() => {
        /* will fall back to system voice if the real play() is later blocked */
      });
    } else {
      audioUnlocked = true;
    }
  } catch {
    /* ignore */
  }
};

const stopPlayback = (): void => {
  try {
    audioEl?.pause();
  } catch {
    /* ignore */
  }
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
};

// Pause keeps the current position (unlike stop, which also bumps the token so onEnd won't fire and
// the clip can't resume). The element/synth retains currentTime, so resume() continues from there.
const pausePlayback = (): void => {
  try {
    audioEl?.pause();
  } catch {
    /* ignore */
  }
  try {
    window.speechSynthesis?.pause();
  } catch {
    /* ignore */
  }
};

const resumePlayback = (): void => {
  try {
    if (audioEl && audioEl.paused && !audioEl.ended && audioEl.currentTime > 0) void audioEl.play();
  } catch {
    /* ignore */
  }
  try {
    window.speechSynthesis?.resume();
  } catch {
    /* ignore */
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface SpeakHandle {
  stop: () => void;
  /** Pause playback, preserving position so resume() continues from where it paused. */
  pause: () => void;
  /** Resume after a pause(). No-op if not paused. */
  resume: () => void;
  /** True while paused mid-playback (false before start, after end, or after stop). */
  isPaused: () => boolean;
  /** True while this handle still owns the engine — i.e. not superseded by a newer speak/word/stop. */
  isActive: () => boolean;
}

export interface SpeakOptions {
  voice?: string;
  rate?: number;
  /** Allow triggering the one-time model download. true for deliberate clicks, false for auto/nav. */
  allowDownload?: boolean;
  /** Start playback this many seconds into the clip (word-level seek). Cached-clip path only. */
  startAt?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (event: any) => void;
}

let currentToken = 0;

// ---------------------------------------------------------------------------
// Shared playback state — single source of truth for the one audio engine
// ---------------------------------------------------------------------------
// Only one thing can play at a time (one <audio> element + speechSynthesis), yet many things start
// playback: the megaphone buttons, the E / Cmd+1·2 keyboard readers, swipe-to-speak, and auto-play.
// They ALL funnel their status through here, keyed by the (stripped) text being spoken, so every
// speaker button can render the TRUE state of whatever is playing — no matter what started it. This
// keeps the megaphone icon in sync (play ⇄ pause) and structurally prevents the old "frozen on the
// pause icon, won't restart" bug: the buttons keep no private playing/paused state to desync.
export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused';
export interface PlaybackState {
  /** Stripped text currently loading/playing/paused, or null when nothing is active. */
  text: string | null;
  status: PlaybackStatus;
}

let playbackState: PlaybackState = { text: null, status: 'idle' };
const playbackListeners = new Set<(s: PlaybackState) => void>();

const setPlaybackState = (patch: Partial<PlaybackState>): void => {
  const next: PlaybackState = { ...playbackState, ...patch };
  if (next.text === playbackState.text && next.status === playbackState.status) return; // no real change
  playbackState = next;
  // Mirror to the OS media session so the lock screen reflects play ⇄ pause in the background.
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState =
        next.status === 'playing' || next.status === 'loading' ? 'playing'
        : next.status === 'paused' ? 'paused'
        : 'none';
    } catch { /* ignore */ }
  }
  playbackListeners.forEach((cb) => { try { cb(playbackState); } catch { /* ignore */ } });
};

/** Read the current playback state (text + status) synchronously. */
export const getPlaybackState = (): PlaybackState => playbackState;

/** Subscribe to playback-state changes; fires immediately with the current value. Returns unsubscribe. */
export const subscribePlayback = (cb: (s: PlaybackState) => void): (() => void) => {
  playbackListeners.add(cb);
  cb(playbackState);
  return () => { playbackListeners.delete(cb); };
};

/** Fraction (0..1) of the active <audio> clip already played; 0 when unknown (e.g. system voice). */
export const getPlaybackProgress = (): number => {
  const a = audioEl;
  if (a && isFinite(a.duration) && a.duration > 0) return Math.min(1, Math.max(0, a.currentTime / a.duration));
  return 0;
};

/** Pause whatever is currently playing (no-op unless something is playing). Keeps position for resume. */
export const pauseCurrent = (): void => {
  if (playbackState.status !== 'playing') return;
  pausePlayback();
  setPlaybackState({ status: 'paused' });
};

/** Resume after pauseCurrent() (no-op unless paused). */
export const resumeCurrent = (): void => {
  if (playbackState.status !== 'paused') return;
  resumePlayback();
  setPlaybackState({ status: 'playing' });
};

/** Stop playback entirely and clear the active text (supersedes the in-flight handle). */
export const stopCurrent = (): void => {
  currentToken++;
  stopPlayback();
  setPlaybackState({ text: null, status: 'idle' });
};

// ---------------------------------------------------------------------------
// Media Session — lock-screen controls + background audio for sentence autoplay
// ---------------------------------------------------------------------------
// Playback already runs through one <audio> element, so wiring the OS Media Session lets the installed
// PWA keep reading sentences with the screen locked and exposes play/pause/next/prev on the lock screen.
// Playback state is mirrored centrally in setPlaybackState (above); metadata + action handlers are driven
// by the autoplay caller (DetailView).
const hasMediaSession = (): boolean => typeof navigator !== 'undefined' && 'mediaSession' in navigator;

/** Set the lock-screen "now playing" card. Safe no-op where Media Session is unsupported. */
export const setMediaMetadata = (info: { title: string; artist?: string; album?: string; artworkUrl?: string }): void => {
  if (!hasMediaSession()) return;
  try {
    const artwork: MediaImage[] = [];
    if (info.artworkUrl) {
      const m = info.artworkUrl.match(/^data:(image\/[a-z0-9.+-]+)/i);
      artwork.push({ src: info.artworkUrl, sizes: '512x512', type: m ? m[1] : 'image/jpeg' });
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title || 'DictProp',
      artist: info.artist || 'DictProp',
      album: info.album || '',
      artwork,
    });
  } catch { /* ignore */ }
};

export interface MediaSessionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
}

/** Register lock-screen action handlers, or pass null to clear them (and the metadata). */
export const setMediaSessionHandlers = (handlers: MediaSessionHandlers | null): void => {
  if (!hasMediaSession()) return;
  const ms = navigator.mediaSession;
  const set = (action: MediaSessionAction, cb?: () => void) => {
    try { ms.setActionHandler(action, cb ? () => cb() : null); } catch { /* action unsupported here */ }
  };
  if (!handlers) {
    (['play', 'pause', 'stop', 'nexttrack', 'previoustrack'] as MediaSessionAction[]).forEach((a) => set(a));
    try { ms.metadata = null; } catch { /* ignore */ }
    return;
  }
  set('play', handlers.onPlay ?? (() => resumeCurrent()));
  set('pause', handlers.onPause ?? (() => pauseCurrent()));
  set('stop', handlers.onStop ?? (() => stopCurrent()));
  set('nexttrack', handlers.onNext);
  set('previoustrack', handlers.onPrev);
};

// Silent keep-alive: a separate, always-on, muted <audio> looped during autoplay so iOS never suspends
// the page during the (up to 10s) gaps between sentences. Both are HTMLAudioElements, so iOS mixes them —
// the keep-alive is inaudible and just holds the audio session open. Started for the whole autoplay run.
let keepAliveEl: HTMLAudioElement | null = null;
const buildSilentWavUrl = (seconds: number): string => {
  const sampleRate = 8000;
  const numSamples = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + numSamples, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);                          // mono, 8-bit
  writeStr(36, 'data'); view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 128);                    // 8-bit silence = unsigned midpoint
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
};

/** Begin the silent keep-alive (idempotent). Call when sentence autoplay starts. */
export const startKeepAlive = (): void => {
  try {
    if (!keepAliveEl) {
      keepAliveEl = new Audio(buildSilentWavUrl(2));
      keepAliveEl.loop = true;
      keepAliveEl.volume = 0;
      (keepAliveEl as any).playsInline = true;
    }
    void keepAliveEl.play().catch(() => { /* retried on the next start */ });
  } catch { /* ignore */ }
};

/** Stop the silent keep-alive. Call when sentence autoplay ends. */
export const stopKeepAlive = (): void => {
  try { keepAliveEl?.pause(); } catch { /* ignore */ }
};

// Device-local cache of ready-to-play object URLs (cached MiMo clips, keyed by ttsKey hash) — replays are instant.
const ttsUrlCache = new Map<string, string>();
// Per-word timings for cached clips, keyed by the SAME ttsKey hash (parallel to ttsUrlCache).
const ttsTimingsCache = new Map<string, WordTiming[]>();
// Timings for whatever the shared <audio> element is currently playing — null on the in-browser /
// system-voice fallbacks (which have no server timings). Powers word-level seek (see seekCurrent).
let currentTimings: WordTiming[] | null = null;

/** Word timings for the clip currently loaded in the audio element, or null when none are available. */
export const getCurrentTimings = (): WordTiming[] | null => currentTimings;

/** Word timings for the CURRENT style's clip of `text` (device cache or server). Null if none exist.
 *  Both styles have timings now, so word-seek works on clear AND casual (keyed by the active style). */
export const getTimingsFor = async (text: string): Promise<WordTiming[] | null> => {
  const plain = stripSentenceMarkers(text).trim();
  if (!plain) return null;
  const key = await ttsKey(plain, styleToken());
  const cached = ttsTimingsCache.get(key);
  if (cached) return cached;
  const t = await fetchCachedTTSTimings(key);
  if (t && t.length) { ttsTimingsCache.set(key, t); return t; }
  return null;
};

/** Ensure word timings exist for `text` (current style): warm them if present, else kick off background
 *  generation (whisper cold-start is ~a minute, so call this when a sentence is shown, not at click). */
export const ensureTimings = async (text: string): Promise<void> => {
  const t = await getTimingsFor(text);
  if (t) return;
  const plain = stripSentenceMarkers(text).trim();
  if (plain) requestTTSGeneration([{ text: plain, voice: styleToken() }]).catch(() => { /* best-effort backfill */ });
};

/** Seek the currently-playing clip to a time offset (seconds) and ensure it's playing. No-op if idle. */
export const seekCurrent = (timeSec: number): void => {
  const a = audioEl;
  if (!a) return;
  try { a.currentTime = Math.max(0, timeSec); } catch { /* ignore */ }
  if (a.paused && !a.ended) { void a.play().catch(() => {}); }
  if (playbackState.status === 'paused') setPlaybackState({ status: 'playing' });
};

// Play an object URL through the shared, iOS-unlocked <audio> element (cached MiMo + Kokoro both use this).
const playUrl = async (
  url: string,
  isCurrent: () => boolean,
  onStart?: () => void,
  onEnd?: () => void,
  startAt?: number,
): Promise<void> => {
  const el = getAudioEl();
  el.onplaying = () => { if (isCurrent()) onStart?.(); };
  el.onended = () => { if (isCurrent()) onEnd?.(); };
  el.onerror = () => { if (isCurrent()) onEnd?.(); };
  el.onloadedmetadata = null;
  const begin = startAt && startAt > 0 ? startAt : 0;
  el.src = url;
  if (begin <= 0) { try { el.currentTime = 0; } catch { /* ignore */ } await el.play(); return; }
  // Start partway in (skip the lead-in / word seek). CRITICAL on iOS: a currentTime set before
  // metadata is loaded is IGNORED, and setting it *after* play() makes the clip start at 0 and then
  // audibly jump to `begin` — i.e. the quiet lead-in plays first and sounds like a fade-in. So wait
  // for metadata, seek, and only THEN play, so playback truly begins at `begin`.
  await new Promise<void>((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      el.onloadedmetadata = null;
      if (!isCurrent()) { resolve(); return; } // superseded → let the newer call drive playback
      try { el.currentTime = begin; } catch { /* ignore */ }
      el.play().then(() => resolve(), () => resolve());
    };
    if (el.readyState >= 1 /* HAVE_METADATA */) go();
    else { el.onloadedmetadata = go; setTimeout(go, 1500); } // fallback if metadata stalls
  });
};

// macOS / desktop cache-miss fallback: synthesize in-browser with Kokoro, then play. Falls back to
// the system voice if the model can't load / consent is declined. iOS/iPadOS never reaches here.
const speakViaKokoro = async (
  plain: string,
  opts: { onStart?: () => void; onEnd?: () => void; allowDownload: boolean },
  isCurrent: () => boolean,
  systemFallback: () => void,
): Promise<void> => {
  const { onStart, onEnd, allowDownload } = opts;
  const wouldDownload = !isModelReady();
  let useNeural = isNeuralSupported() && (isModelReady() || allowDownload);
  if (useNeural && wouldDownload && allowDownload && !confirmDownloadIfNeeded()) useNeural = false;
  if (!useNeural) { systemFallback(); return; }
  try {
    const url = await synthesize(plain, DEFAULT_VOICE);
    if (!isCurrent()) return;
    await playUrl(url, isCurrent, onStart, onEnd);
  } catch (err) {
    if (!isCurrent()) return;
    warn('🔊 Kokoro failed, falling back to system voice', err);
    systemFallback();
  }
};

/**
 * Prefetch cached clips for the given texts into the device-local cache so a later tap is instant
 * (and plays through the iOS-unlocked <audio> element, avoiding the gesture-after-await problem).
 * Fetch-only — never triggers generation.
 */
export const prefetchTTS = (texts: string[]): void => {
  const token = styleToken();
  for (const raw of texts) {
    const plain = stripSentenceMarkers(raw || '').trim();
    if (!plain) continue;
    (async () => {
      const key = await ttsKey(plain, token);
      if (!ttsUrlCache.has(key)) {
        const blob = await fetchCachedTTS(key);
        if (blob && !ttsUrlCache.has(key)) ttsUrlCache.set(key, URL.createObjectURL(blob));
      }
      if (!ttsTimingsCache.has(key)) {
        const t = await fetchCachedTTSTimings(key);
        if (t && t.length) ttsTimingsCache.set(key, t);
      }
    })().catch(() => { /* best-effort */ });
  }
};

/**
 * Like prefetchTTS, but GENERATES any clip that isn't cached yet (then pulls it into the device cache),
 * so a later tap plays the API voice instantly instead of hitting a cache-miss fallback. Use this when
 * fresh AI results arrive (search / refresh) to prepare the audio up front. Fire-and-forget.
 */
export const ensureTTS = async (texts: string[]): Promise<void> => {
  try {
    const token = styleToken();
    const plains = Array.from(new Set(texts.map(t => stripSentenceMarkers(t || '').trim()).filter(Boolean)));
    if (!plains.length) return;

    // Pull anything already cached (device → server) into the device cache; collect what's still missing.
    const missing: string[] = [];
    await Promise.all(plains.map(async (plain) => {
      const key = await ttsKey(plain, token);
      if (ttsUrlCache.has(key)) return;
      const blob = await fetchCachedTTS(key);
      if (blob) { if (!ttsUrlCache.has(key)) ttsUrlCache.set(key, URL.createObjectURL(blob)); return; }
      missing.push(plain);
    }));
    if (missing.length) {
      // Generate the missing clips server-side (one batch), then fetch them into the device cache.
      await requestTTSGeneration(missing.map(text => ({ text, voice: token })));
      await Promise.all(missing.map(async (plain) => {
        const key = await ttsKey(plain, token);
        if (ttsUrlCache.has(key)) return;
        const blob = await fetchCachedTTS(key);
        if (blob && !ttsUrlCache.has(key)) ttsUrlCache.set(key, URL.createObjectURL(blob));
      }));
    }
    // Warm per-word timings (both styles have them now) so tap-to-seek is ready on the first tap.
    await Promise.all(plains.map(async (plain) => {
      const key = await ttsKey(plain, token);
      if (ttsTimingsCache.has(key)) return;
      const t = await fetchCachedTTSTimings(key);
      if (t && t.length) ttsTimingsCache.set(key, t);
    }));
  } catch {
    /* best-effort — speakNatural still falls back at play time */
  }
};

/**
 * Like ensureTTS, but reports progress (done/total over the de-duplicated set) so a UI can show a
 * "preloading N/M" indicator. Used to warm the WHOLE review session up front (audio clips + per-word
 * timings) so an unstable network can't interrupt playback mid-session. Best-effort per item: a
 * failure still ticks progress and never rejects the whole batch.
 */
export const preloadAudio = async (
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> => {
  const token = styleToken();
  const plains = Array.from(new Set(texts.map(t => stripSentenceMarkers(t || '').trim()).filter(Boolean)));
  const total = plains.length;
  onProgress?.(0, total);
  if (!total) return;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  // 1) Pull anything already cached (device → server) into the device cache + warm its timings
  //    (both styles have timings now); collect what still needs generating.
  const missing: string[] = [];
  await Promise.all(plains.map(async (plain) => {
    try {
      const key = await ttsKey(plain, token);
      if (ttsUrlCache.has(key)) { tick(); return; }
      const blob = await fetchCachedTTS(key);
      if (blob) {
        if (!ttsUrlCache.has(key)) ttsUrlCache.set(key, URL.createObjectURL(blob));
        if (!ttsTimingsCache.has(key)) {
          const t = await fetchCachedTTSTimings(key);
          if (t && t.length) ttsTimingsCache.set(key, t);
        }
        tick();
        return;
      }
      missing.push(plain); // still missing → generate below
    } catch { tick(); }
  }));

  // 2) Generate the missing clips server-side (one batch), then fetch them into the device cache.
  if (missing.length) {
    try { await requestTTSGeneration(missing.map(text => ({ text, voice: token }))); } catch { /* best-effort */ }
    await Promise.all(missing.map(async (plain) => {
      try {
        const key = await ttsKey(plain, token);
        if (!ttsUrlCache.has(key)) {
          const blob = await fetchCachedTTS(key);
          if (blob && !ttsUrlCache.has(key)) ttsUrlCache.set(key, URL.createObjectURL(blob));
        }
        if (!ttsTimingsCache.has(key)) {
          const t = await fetchCachedTTSTimings(key);
          if (t && t.length) ttsTimingsCache.set(key, t);
        }
      } catch { /* ignore */ }
      tick();
    }));
  }
};

// MiMo clips carry a quiet ~100ms lead-in (a soft breath/onset) before speech — heard as "starts quiet,
// then louder". When the caller hasn't asked for a specific start, begin at the first word's timestamp
// (less a small preroll so a soft onset isn't clipped) to drop that lead-in. Falls back to 0 when
// timings aren't warm yet, so it degrades to the old behaviour rather than guessing a fixed offset.
const LEAD_IN_PREROLL = 0.03; // seconds kept before the first word, as a safety margin vs clipping the onset
const leadInSkip = (timings: WordTiming[] | null): number => {
  const first = timings?.[0]?.start;
  return first && isFinite(first) ? Math.max(0, first - LEAD_IN_PREROLL) : 0;
};

/**
 * Speak `text` with the best available voice:
 *   1. cached MiMo clip from the server (instant, on every device) — the primary path
 *   2. on a cache MISS: kick off background generation (fills the cache for next time), then fall
 *      back immediately — macOS/desktop → in-browser Kokoro, iOS/iPadOS → system Web Speech voice.
 * The cache miss never blocks the tap on the ~2.75 s generation. Returns a handle whose
 * stop()/pause()/resume() control whichever backend ends up playing.
 */
export const speakNatural = (text: string, opts: SpeakOptions = {}): SpeakHandle => {
  const plain = stripSentenceMarkers(text).trim();
  if (!plain) return { stop: () => {}, pause: () => {}, resume: () => {}, isPaused: () => false, isActive: () => false };

  const { rate, startAt, onStart, onEnd, onError, allowDownload = true } = opts;
  const token = ++currentToken;
  const isCurrent = () => token === currentToken;

  // Drive the shared playback state so every speaker UI reflects THIS playback (keyed by text),
  // whatever triggered it. Gated by isCurrent() so a superseded call can't clobber a newer one's state.
  const markStart = () => { if (isCurrent()) setPlaybackState({ status: 'playing' }); onStart?.(); };
  const markEnd = () => { if (isCurrent()) setPlaybackState({ text: null, status: 'idle' }); onEnd?.(); };
  const markError = (e: any) => { if (isCurrent()) setPlaybackState({ text: null, status: 'idle' }); onError?.(e); };
  const systemFallback = () => systemSpeak(plain, { rate, onStart: markStart, onEnd: markEnd, onError: markError });

  // Unlock <audio> synchronously inside the gesture (iOS) and stop anything currently playing.
  unlockAudio();
  stopPlayback();
  setPlaybackState({ text: plain, status: 'loading' });

  // Capture the style for THIS call so a mid-play toggle can't switch tracks underneath it.
  const casual = ttsStyle === 'casual';
  const voiceTok = casual ? CASUAL_TOKEN : TTS_VOICE;

  (async () => {
    try {
      const key = await ttsKey(plain, voiceTok);
      if (!isCurrent()) return; // superseded by a newer call

      // 1) device-local cache, then 2) server cache (for the chosen style)
      let url = ttsUrlCache.get(key);
      if (!url) {
        const blob = await fetchCachedTTS(key);
        if (!isCurrent()) return;
        if (blob) {
          url = URL.createObjectURL(blob);
          ttsUrlCache.set(key, url);
        }
      }
      if (url) {
        // Resolve per-word timings for seek (both styles have them): device cache, else fetch from
        // server (non-blocking). On a legacy timings-less clip, kick off generation to backfill them.
        currentTimings = ttsTimingsCache.get(key) ?? null;
        if (!currentTimings) {
          fetchCachedTTSTimings(key).then((t) => {
            if (t && t.length) { ttsTimingsCache.set(key, t); if (isCurrent()) currentTimings = t; }
            else { requestTTSGeneration([{ text: plain, voice: voiceTok }]).catch(() => {}); } // backfill timings for this style
          }).catch(() => {});
        }
        // Caller-specified start (word-level seek) wins; otherwise auto-skip the quiet lead-in.
        const begin = startAt && startAt > 0 ? startAt : leadInSkip(currentTimings);
        await playUrl(url, isCurrent, markStart, markEnd, begin);
        return;
      }

      // Casual MISS → queue its generation, but don't make the user wait: fall back to the
      // (essentially always-cached) CLEAR clip right now so the sentence still plays immediately.
      if (casual) {
        requestTTSGeneration([{ text: plain, voice: CASUAL_TOKEN }]).catch(() => { /* best-effort */ });
        const clearKey = await ttsKey(plain, TTS_VOICE);
        if (!isCurrent()) return;
        let clearUrl = ttsUrlCache.get(clearKey);
        if (!clearUrl) {
          const blob = await fetchCachedTTS(clearKey);
          if (!isCurrent()) return;
          if (blob) { clearUrl = URL.createObjectURL(blob); ttsUrlCache.set(clearKey, clearUrl); }
        }
        if (clearUrl) {
          currentTimings = ttsTimingsCache.get(clearKey) ?? null;
          const begin = startAt && startAt > 0 ? startAt : leadInSkip(currentTimings);
          await playUrl(clearUrl, isCurrent, markStart, markEnd, begin);
          return;
        }
        // clear also absent → fall through to the generic miss path below
      }

      // 3) MISS — fill the clear cache for next time (fire-and-forget), then fall back now (no timings).
      currentTimings = null;
      requestTTSGeneration([{ text: plain, voice: TTS_VOICE }]).catch(() => { /* best-effort */ });
      if (isIOS()) { systemFallback(); return; }
      await speakViaKokoro(plain, { onStart: markStart, onEnd: markEnd, allowDownload }, isCurrent, systemFallback);
    } catch (err) {
      if (!isCurrent()) return;
      warn('🔊 TTS chain failed, falling back to system voice', err);
      systemFallback();
    }
  })();

  return {
    stop: () => { if (isCurrent()) stopCurrent(); },
    pause: () => { if (isCurrent()) pauseCurrent(); },
    resume: () => { if (isCurrent()) resumeCurrent(); },
    isPaused: () => isCurrent() && playbackState.status === 'paused',
    isActive: () => isCurrent(),
  };
};

/**
 * Speak a single word / card title (the item itself) with the BUILT-IN system voice — instant,
 * free, and fine for one word. Only example SENTENCES use the cached MiMo voice (speakNatural).
 * Stops any cached/Kokoro sentence first so a word tap interrupts cleanly.
 */
export const speakWord = (text: string): SpeakHandle => {
  const plain = stripSentenceMarkers(text).trim();
  const token = ++currentToken;                       // supersede any active sentence handle
  currentTimings = null;                              // a word read has no seekable sentence timings
  setPlaybackState({ text: null, status: 'idle' });   // a word isn't shown by any speaker button → clear them
  stopPlayback();
  systemSpeak(plain);
  const isCurrent = () => token === currentToken;
  return {
    stop: () => { try { window.speechSynthesis?.cancel(); } catch { /* ignore */ } },
    pause: () => { try { window.speechSynthesis?.pause(); } catch { /* ignore */ } },
    resume: () => { try { window.speechSynthesis?.resume(); } catch { /* ignore */ } },
    isPaused: () => typeof window !== 'undefined' && !!window.speechSynthesis?.paused,
    isActive: () => isCurrent() && typeof window !== 'undefined' && !!(window.speechSynthesis?.speaking || window.speechSynthesis?.paused),
  };
};
