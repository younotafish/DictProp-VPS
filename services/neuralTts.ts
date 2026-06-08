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
import { ttsKey, fetchCachedTTS, requestTTSGeneration, TTS_VOICE } from './api';
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
}

export interface SpeakOptions {
  voice?: string;
  rate?: number;
  /** Allow triggering the one-time model download. true for deliberate clicks, false for auto/nav. */
  allowDownload?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (event: any) => void;
}

let currentToken = 0;

// Device-local cache of ready-to-play object URLs (cached MiMo clips, keyed by ttsKey hash) — replays are instant.
const ttsUrlCache = new Map<string, string>();

// Play an object URL through the shared, iOS-unlocked <audio> element (cached MiMo + Kokoro both use this).
const playUrl = async (
  url: string,
  isCurrent: () => boolean,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> => {
  const el = getAudioEl();
  el.onplaying = () => { if (isCurrent()) onStart?.(); };
  el.onended = () => { if (isCurrent()) onEnd?.(); };
  el.onerror = () => { if (isCurrent()) onEnd?.(); };
  el.src = url;
  try { el.currentTime = 0; } catch { /* fresh src already starts at 0 */ }
  await el.play();
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
  for (const raw of texts) {
    const plain = stripSentenceMarkers(raw || '').trim();
    if (!plain) continue;
    (async () => {
      const key = await ttsKey(plain, TTS_VOICE);
      if (ttsUrlCache.has(key)) return;
      const blob = await fetchCachedTTS(key);
      if (blob && !ttsUrlCache.has(key)) ttsUrlCache.set(key, URL.createObjectURL(blob));
    })().catch(() => { /* best-effort */ });
  }
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
  if (!plain) return { stop: () => {}, pause: () => {}, resume: () => {}, isPaused: () => false };

  const { rate, onStart, onEnd, onError, allowDownload = true } = opts;
  const token = ++currentToken;
  const isCurrent = () => token === currentToken;
  const systemFallback = () => systemSpeak(plain, { rate, onStart, onEnd, onError });

  // Unlock <audio> synchronously inside the gesture (iOS) and stop anything currently playing.
  unlockAudio();
  stopPlayback();

  (async () => {
    try {
      const key = await ttsKey(plain, TTS_VOICE);
      if (!isCurrent()) return; // superseded by a newer call

      // 1) device-local cache, then 2) server cache
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
        await playUrl(url, isCurrent, onStart, onEnd);
        return;
      }

      // 3) MISS — fill the cache for next time (fire-and-forget), then fall back now.
      requestTTSGeneration([{ text: plain }]).catch(() => { /* best-effort */ });
      if (isIOS()) { systemFallback(); return; }
      await speakViaKokoro(plain, { onStart, onEnd, allowDownload }, isCurrent, systemFallback);
    } catch (err) {
      if (!isCurrent()) return;
      warn('🔊 TTS chain failed, falling back to system voice', err);
      systemFallback();
    }
  })();

  return {
    stop: () => { if (isCurrent()) currentToken++; stopPlayback(); },
    pause: () => { if (isCurrent()) pausePlayback(); },
    resume: () => { if (isCurrent()) resumePlayback(); },
    isPaused: () =>
      isCurrent() &&
      ((!!audioEl && audioEl.paused && !audioEl.ended && audioEl.currentTime > 0) ||
        (typeof window !== 'undefined' && !!window.speechSynthesis?.paused)),
  };
};

/**
 * Speak a single word / card title with the best voice. Same cache-first chain as speakNatural,
 * but never triggers the one-time Kokoro download — incidental word taps shouldn't pull 326 MB.
 * (On a macOS cache miss with Kokoro already warmed it still uses Kokoro; otherwise system voice.)
 */
export const speakWord = (text: string): SpeakHandle => speakNatural(text, { allowDownload: false });
