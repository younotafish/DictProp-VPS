import { cancelSpeech } from '../speech';
import { getPlaybackRate, subscribePlaybackRate } from '../ttsSettings';
import { mirrorPlaybackStatus } from './mediaSession';

// Tiny valid silent WAV — played once inside a user gesture to unlock <audio> on iOS Safari,
// so a later play() after the async synth await isn't blocked as non-user-initiated.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
let audioEl: HTMLAudioElement | null = null;
let audioUnlocked = false;

const getAudioEl = (): HTMLAudioElement => {
  if (!audioEl) audioEl = new Audio();
  return audioEl;
};

/** The source the shared <audio> element is set to, if it exists. */
export const playingSource = (): string | undefined => audioEl?.src;

/** Play a silent clip inside the click gesture so iOS lets us play the real audio later. */
export const unlockAudio = (): void => {
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

export const stopPlayback = (): void => {
  try {
    audioEl?.pause();
  } catch {
    /* ignore */
  }
  cancelSpeech();
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

const resumePlayback = (onRefused: () => void): void => {
  try {
    if (audioEl && audioEl.paused && !audioEl.ended && audioEl.currentTime > 0) audioEl.play().catch(onRefused);
  } catch {
    /* ignore */
  }
  try {
    window.speechSynthesis?.resume();
  } catch {
    /* ignore */
  }
};

let currentToken = 0;

/** Make a new request the current one, superseding whatever was active. Returns that request's check. */
export const supersedePlayback = (): (() => boolean) => {
  const token = ++currentToken;
  return () => token === currentToken;
};

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

export const setPlaybackState = (patch: Partial<PlaybackState>): void => {
  const next: PlaybackState = { ...playbackState, ...patch };
  if (next.text === playbackState.text && next.status === playbackState.status) return; // no real change
  playbackState = next;
  mirrorPlaybackStatus(next.status);
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
  const token = currentToken;
  resumePlayback(() => {
    // The browser refused (iOS can want a fresh tap after an interruption): it's still paused.
    if (token === currentToken && playbackState.status === 'playing') setPlaybackState({ status: 'paused' });
  });
  setPlaybackState({ status: 'playing' });
};

/** Stop playback entirely and clear the active text (supersedes the in-flight handle). */
export const stopCurrent = (): void => {
  currentToken++;
  stopPlayback();
  setPlaybackState({ text: null, status: 'idle' });
};

subscribePlaybackRate(rate => {
  if (audioEl) {
    audioEl.defaultPlaybackRate = rate;
    audioEl.playbackRate = rate;
  }
});

/** Seek the currently-playing clip to a time offset (seconds) and ensure it's playing. No-op if idle. */
export const seekCurrent = (timeSec: number): void => {
  const a = audioEl;
  if (!a) return;
  try { a.currentTime = Math.max(0, timeSec); } catch { /* ignore */ }
  if (a.paused && !a.ended) { void a.play().catch(() => {}); }
  if (playbackState.status === 'paused') setPlaybackState({ status: 'playing' });
};

// Apply the global voice speed to the shared <audio> element. preservesPitch keeps a faster rate
// from raising the pitch (chipmunk). Set right before each play(): loading a new src can reset
// playbackRate to defaultPlaybackRate, so we set both. Vendor-prefixed field covers older Safari.
const applyRate = (el: HTMLAudioElement): void => {
  try {
    (el as any).preservesPitch = true;
    (el as any).webkitPreservesPitch = true;
    el.defaultPlaybackRate = getPlaybackRate();
    el.playbackRate = getPlaybackRate();
  } catch { /* ignore */ }
};

// Play an object URL through the shared, iOS-unlocked <audio> element (cached MiMo + Kokoro both use this).
export const playUrl = async (
  url: string,
  isCurrent: () => boolean,
  onStart?: () => void,
  onEnd?: () => void,
  startAt?: number,
): Promise<void> => {
  const el = getAudioEl();
  let started = false;
  el.onplaying = () => { started = true; if (isCurrent()) onStart?.(); };
  el.onended = () => { if (isCurrent()) onEnd?.(); };
  // Before playback starts, a bad clip rejects play() below and the caller falls back to another voice;
  // ending here as well would let the caller move on while that fallback still speaks.
  el.onerror = () => { if (started && isCurrent()) onEnd?.(); };
  el.onloadedmetadata = null;
  const begin = startAt && startAt > 0 ? startAt : 0;
  el.src = url;
  if (begin <= 0) { try { el.currentTime = 0; } catch { /* ignore */ } applyRate(el); await el.play(); return; }
  // Start partway in (skip the lead-in / word seek). CRITICAL on iOS: a currentTime set before
  // metadata is loaded is IGNORED, and setting it *after* play() makes the clip start at 0 and then
  // audibly jump to `begin` — i.e. the quiet lead-in plays first and sounds like a fade-in. So wait
  // for metadata, seek, and only THEN play, so playback truly begins at `begin`.
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      if (done) return;
      done = true;
      clearTimeout(fallbackTimer);
      // A newer call may have loaded its own clip meanwhile: leave its metadata handler in place.
      if (el.onloadedmetadata === go) el.onloadedmetadata = null;
      if (!isCurrent()) { resolve(); return; } // superseded → let the newer call drive playback
      try { el.currentTime = begin; } catch { /* ignore */ }
      applyRate(el);
      el.play().then(() => resolve(), reject); // a refused play() falls back, as on the path above
    };
    if (el.readyState >= 1 /* HAVE_METADATA */) go();
    else { el.onloadedmetadata = go; fallbackTimer = setTimeout(go, 1500); } // fallback if metadata stalls
  });
};
