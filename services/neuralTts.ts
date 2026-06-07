/**
 * In-browser neural TTS (Kokoro-82M via kokoro-js / Transformers.js).
 *
 * Produces a natural voice that runs 100% on-device — zero network roundtrip after a
 * one-time ~86 MB model download (fetched from the Hugging Face CDN into the browser's
 * Cache Storage, so it works offline afterward and never touches our server).
 *
 * Device policy (see speakNatural):
 *  - WebGPU present  -> use Kokoro.
 *  - No WebGPU       -> use the system Web Speech voice (services/speech.ts) — today's
 *                       behavior, no download, no regression.
 *  - Runtime failure -> fall back to the system voice and disable neural for the session.
 *
 * The 86 MB model is only ever downloaded on a *deliberate* speaker-button click
 * (allowDownload: true). Automatic/navigation speech passes allowDownload: false, so it
 * upgrades to the natural voice once the model is already resident but never triggers a
 * download on its own.
 */
import { speak as systemSpeak } from './speech';
import { stripSentenceMarkers } from '../components/HighlightedSentence';
import { log, warn } from './logger';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// dtype for the WebGPU backend (we run WebGPU-only). Observed on WebGPU:
//   q8  (~86 MB)  — garbled audio (int8 ops misbehave on the WebGPU EP). Do NOT use.
//   fp16 (~163 MB) — correct words but audible static/noise (reduced precision).
//   fp32 (~326 MB) — clean, full quality. kokoro-js recommends fp32 for WebGPU.
const DTYPE = 'fp32';
export const DEFAULT_VOICE = 'af_heart'; // American female, grade A (matches our GA/rhotic IPA)

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
/** True when the device can run Kokoro acceptably (WebGPU). The gate for Kokoro vs. system voice. */
export const isNeuralSupported = (): boolean =>
  typeof navigator !== 'undefined' && !!(navigator as any).gpu;

const isMobile = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)); // iPadOS

const hasConsent = (): boolean => {
  try {
    return localStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
};

/** On mobile, confirm the one-time ~86 MB download before pulling it (respect cellular data). */
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

const loadModel = async (): Promise<KokoroInstance> => {
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
    dtype: DTYPE as any,
    device: 'webgpu',
    progress_callback: (p: any) => {
      if (p && p.status === 'progress' && typeof p.progress === 'number') {
        setStatus('loading', Math.max(0, Math.min(1, p.progress / 100)));
      }
    },
  });
};

// WebGPU device init and the one-time ~330 MB download can flake transiently, so retry a few
// times — already-fetched files come from the browser cache, so retries are cheap. On final
// failure we reset modelPromise so the NEXT play tries again: no permanent session lockout,
// no need to hard-refresh.
const ensureModel = (): Promise<KokoroInstance> => {
  if (modelPromise) return modelPromise;
  setStatus('loading', 0);
  modelPromise = (async () => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const tts = await loadModel();
        log(`🔊 Neural TTS: Kokoro model ready (${DTYPE}, webgpu)`);
        setStatus('ready', 1);
        return tts;
      } catch (e) {
        lastErr = e;
        warn(`🔊 Neural TTS: model load attempt ${attempt}/3 failed; retrying…`, e);
        setStatus('loading', 0);
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw lastErr;
  })();
  modelPromise.catch(() => {
    modelPromise = null; // allow a fresh attempt on the next play
    setStatus('error');
  });
  return modelPromise;
};

/**
 * Proactively download + initialize the model in the background so the first play (or autoplay) is
 * instant. Safe to call repeatedly — it no-ops when WebGPU is absent, when a load is already
 * underway/done/errored this session, or (on mobile) when the one-time ~330 MB download hasn't been
 * consented to yet (we never pull it silently over cellular).
 */
export const preloadNeural = (): void => {
  if (!isNeuralSupported()) return;        // no WebGPU → system-voice path, nothing to fetch
  if (status !== 'idle') return;           // already loading / ready / errored this session
  if (isMobile() && !hasConsent()) return; // wait for deliberate consent before a big mobile download
  log('🔊 Neural TTS: preloading model in the background');
  ensureModel().catch(() => { /* ensureModel resets state so a later deliberate play can retry */ });
};

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

/**
 * Speak `text` with the natural neural voice when the device supports it and the model is
 * available (or a download is permitted); otherwise fall back to the system Web Speech voice.
 * Returns a handle whose stop() halts playback.
 */
export const speakNatural = (text: string, opts: SpeakOptions = {}): SpeakHandle => {
  const plain = stripSentenceMarkers(text).trim();
  if (!plain) return { stop: () => {}, pause: () => {}, resume: () => {}, isPaused: () => false };

  const { voice = DEFAULT_VOICE, rate, onStart, onEnd, onError, allowDownload = true } = opts;

  const token = ++currentToken;
  const isCurrent = () => token === currentToken;

  const fallback = () => systemSpeak(plain, { rate, onStart, onEnd, onError });

  // Decide engine. Neural needs WebGPU, not session-disabled, and either an already-loaded
  // model or permission to download it.
  const wouldDownload = !isModelReady();
  let useNeural = isNeuralSupported() && (isModelReady() || allowDownload);

  // On mobile, get one-time consent before the first (downloading) use.
  if (useNeural && wouldDownload && allowDownload && !confirmDownloadIfNeeded()) {
    useNeural = false;
  }

  if (!useNeural) {
    fallback();
    return {
      stop: () => {
        if (isCurrent()) currentToken++;
        try {
          window.speechSynthesis?.cancel();
        } catch {
          /* ignore */
        }
      },
      pause: () => {
        if (isCurrent()) {
          try { window.speechSynthesis?.pause(); } catch { /* ignore */ }
        }
      },
      resume: () => {
        if (isCurrent()) {
          try { window.speechSynthesis?.resume(); } catch { /* ignore */ }
        }
      },
      isPaused: () => isCurrent() && typeof window !== 'undefined' && !!window.speechSynthesis?.paused,
    };
  }

  // Neural path — unlock audio synchronously (iOS) and stop anything currently playing.
  unlockAudio();
  stopPlayback();

  (async () => {
    try {
      const url = await synthesize(plain, voice);
      if (!isCurrent()) return; // superseded by a newer call
      const el = getAudioEl();
      el.onplaying = () => {
        if (isCurrent()) onStart?.();
      };
      el.onended = () => {
        if (isCurrent()) onEnd?.();
      };
      el.onerror = () => {
        if (isCurrent()) onEnd?.();
      };
      el.src = url;
      try {
        el.currentTime = 0; // restart when replaying the same cached clip
      } catch {
        /* media not ready yet — the fresh src already starts at 0 */
      }
      await el.play();
    } catch (err) {
      if (!isCurrent()) return;
      warn('🔊 Neural TTS failed, falling back to system voice', err);
      fallback();
    }
  })();

  return {
    stop: () => {
      if (isCurrent()) currentToken++;
      stopPlayback();
    },
    pause: () => { if (isCurrent()) pausePlayback(); },
    resume: () => { if (isCurrent()) resumePlayback(); },
    isPaused: () => isCurrent() && !!audioEl && audioEl.paused && !audioEl.ended && audioEl.currentTime > 0,
  };
};
