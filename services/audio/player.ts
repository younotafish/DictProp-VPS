/**
 * The player: the one shared <audio> element, the system voice, and the playback record every speaker button
 * reads. Only one thing plays at a time, so every request, pause, resume, seek and stop goes through here.
 */
import { cancelSpeech, speak as systemSpeak } from '../speech';
import { getPlaybackRate, subscribePlaybackRate } from '../ttsSettings';
import { mirrorPlaybackStatus } from './mediaSession';
import { setUrlInUse } from './urlLru';

// Tiny valid silent WAV — played once inside a user gesture to unlock <audio> on iOS Safari,
// so a later play() after the async synth await isn't blocked as non-user-initiated.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

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

/** The output sounding the active request: a clip in the shared <audio> element, or the system voice. */
export type PlaybackBackend = 'clip' | 'speech';

/**
 * What ended a live request its owner didn't stop itself: another request ('superseded': a sentence or a word), a stop
 * from elsewhere ('stopped'), or a change of speech style ('style-changed').
 */
export type InterruptReason = 'superseded' | 'stopped' | 'style-changed';

/** A live request, or a hold on the engine between reads (reservePlayback), and who to tell when something ends it. */
interface RequestRecord {
  token: number;
  onInterrupted?: (reason: InterruptReason) => void;
}

interface PlayerRecord {
  /** Bumped by every request and every stop, so callbacks from a superseded request do nothing. */
  token: number;
  /** What the speaker buttons show, published to subscribers on every change. */
  state: PlaybackState;
  /** The active request's output once it has one; null while it loads and when nothing is active. Resume,
   *  progress and seek act on the <audio> element only while it's 'clip': otherwise the element may still hold an
   *  earlier clip, or one the browser refused to play. A pause pauses the element whatever the output, which does
   *  no harm: the element is already paused then. */
  backend: PlaybackBackend | null;
  /** The live request (its token is the current one) until it ends, fails or is superseded; null otherwise. */
  request: RequestRecord | null;
  /** A pause was asked for while the current request loaded: its output stays silent until resumeCurrent(). */
  pendingPause: boolean;
  /** ...and the output is ready and held: a clip set on the element but not played, or one paused as it started. */
  armed: boolean;
  /**
   * The playUrl call whose clip the pause held before it ever played. It settles with the play that ends the hold, so a
   * clip that can't be played fails it and its caller falls back to another voice, as without the pause.
   */
  heldPlay: { resolve: () => void; reject: (error: unknown) => void } | null;
}

const player: PlayerRecord = {
  token: 0, state: { text: null, status: 'idle' }, backend: null, request: null, pendingPause: false, armed: false,
  heldPlay: null,
};
const playbackListeners = new Set<(s: PlaybackState) => void>();

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
let audioEl: HTMLAudioElement | null = null;

const getAudioEl = (): HTMLAudioElement => {
  if (!audioEl) audioEl = new Audio();
  return audioEl;
};

/**
 * Play a silent clip inside the click gesture so iOS lets us play the real audio later; it also clears the
 * previous clip off the element. The play() call made inside the gesture is what unlocks the element: the
 * caller pauses it straight away (stopPlayback), which rejects its promise, and that outcome doesn't matter.
 */
export const unlockAudio = (): void => {
  try {
    const el = getAudioEl();
    el.src = SILENT_WAV;
    setUrlInUse(SILENT_WAV);
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.catch(() => {
        /* the pause that follows rejects it; a real play() the browser blocks later falls back to the system voice */
      });
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

// Pause keeps the current position (unlike stopCurrent, which also bumps the token so onEnd won't fire and
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
    if (player.backend === 'clip' && audioEl && audioEl.paused && !audioEl.ended && audioEl.currentTime > 0) audioEl.play().catch(onRefused);
  } catch {
    /* ignore */
  }
  try {
    window.speechSynthesis?.resume();
  } catch {
    /* ignore */
  }
};

/** Let the held playUrl call go: done (its clip plays, or its request is over), or failed with `failure.error`. */
const settleHeldPlay = (failure?: { error: unknown }): void => {
  const held = player.heldPlay;
  player.heldPlay = null;
  if (failure) held?.reject(failure.error);
  else held?.resolve();
};

/** Tell a request's owner once, after the code that ended it has finished, unless the owner let go first. */
const reportInterruption = (record: RequestRecord, reason: InterruptReason): void => {
  queueMicrotask(() => {
    const onInterrupted = record.onInterrupted;
    record.onInterrupted = undefined;
    onInterrupted?.(reason);
  });
};

/**
 * Make a new request the current one, superseding whatever was active. Returns that request's check. A request still
 * live hears `reason` in a microtask, so its owner can tell another caller's speech or stop from its own.
 */
export const supersedePlayback = (reason: InterruptReason = 'superseded'): (() => boolean) => {
  const live = player.request?.token === player.token ? player.request : null;
  const token = ++player.token;
  player.backend = null;
  player.request = null;
  player.pendingPause = false;
  player.armed = false;
  settleHeldPlay();
  if (live) reportInterruption(live, reason);
  return () => token === player.token;
};

/** The current request's check, without starting one: true until anything supersedes that request. */
export const currentRequestCheck = (): (() => boolean) => {
  const token = player.token;
  return () => token === player.token;
};

/**
 * Start a request that tells `onInterrupted` if another request or a stop ends it before it ends by itself. release()
 * lets go first, as the owner does before stopping the request itself, so the owner's own stop is never reported.
 */
export const startRequest = (onInterrupted?: (reason: InterruptReason) => void): { isCurrent: () => boolean; release: () => void } => {
  const isCurrent = supersedePlayback();
  const record: RequestRecord = { token: player.token, onInterrupted };
  player.request = record;
  return { isCurrent, release: () => { record.onInterrupted = undefined; } };
};

/**
 * Hold the engine between reads: until the returned release(), the next request or stop by anyone (a sentence, a word,
 * a stop, a change of style) is reported to `onInterrupted`, as it would be to a read's owner. Taken while another
 * request is still live, it reports that at once ('superseded'), since something else already speaks.
 */
export const reservePlayback = (onInterrupted: (reason: InterruptReason) => void): (() => void) => {
  const record: RequestRecord = { token: player.token, onInterrupted };
  if (player.request?.token === player.token) reportInterruption(record, 'superseded');
  else player.request = record;
  return () => {
    record.onInterrupted = undefined;
    if (player.request === record) player.request = null;
  };
};

export const setPlaybackState = (patch: Partial<PlaybackState>): void => {
  const next: PlaybackState = { ...player.state, ...patch };
  if (next.text === player.state.text && next.status === player.state.status) return; // no real change
  player.state = next;
  mirrorPlaybackStatus(next.status);
  playbackListeners.forEach((cb) => { try { cb(player.state); } catch { /* ignore */ } });
};

/** The current request finished, or failed for good: nothing is active any more, and nothing can interrupt it. */
export const endPlayback = (): void => {
  player.backend = null;
  player.request = null;
  player.pendingPause = false;
  player.armed = false;
  settleHeldPlay();
  setPlaybackState({ text: null, status: 'idle' });
};

/** The current request's output started. A pause asked for while it loaded takes hold now, before anyone hears it. */
export const markPlaying = (): void => {
  if (player.pendingPause) {
    pausePlayback();
    player.armed = true;
    return;
  }
  setPlaybackState({ status: 'playing' });
};

/**
 * The current request's number: each read (speakNatural, a word, a stop) takes a new one, and a pause and its resume
 * keep it, so the study signals count a read once however its state moves.
 */
export const getPlaybackToken = (): number => player.token;

/** Read the current playback state (text + status) synchronously. */
export const getPlaybackState = (): PlaybackState => player.state;

/** Subscribe to playback-state changes; fires immediately with the current value. Returns unsubscribe. */
export const subscribePlayback = (cb: (s: PlaybackState) => void): (() => void) => {
  playbackListeners.add(cb);
  cb(player.state);
  return () => { playbackListeners.delete(cb); };
};

/** Fraction (0..1) of the active <audio> clip already played; 0 when unknown (e.g. system voice). */
export const getPlaybackProgress = (): number => {
  const a = audioEl;
  if (player.backend === 'clip' && a && isFinite(a.duration) && a.duration > 0) return Math.min(1, Math.max(0, a.currentTime / a.duration));
  return 0;
};

/**
 * Pause whatever is playing, keeping its position for resume. A read still loading is held too: it shows paused at
 * once, and its output stays silent once ready, until resumeCurrent(). No-op while idle or paused.
 */
export const pauseCurrent = (): void => {
  if (player.state.status === 'loading') {
    player.pendingPause = true;
    setPlaybackState({ status: 'paused' });
    return;
  }
  if (player.state.status !== 'playing') return;
  pausePlayback();
  setPlaybackState({ status: 'paused' });
};

/** A refused play() that a later one may get past: the browser wants a fresh tap, or the play was cut short. */
const mayPlayLater = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
};

/**
 * Play the clip a pause holds, for a resume or a seek. A refusal a later play may get past holds it again, so the next
 * resume tries again. Any other failure (a clip the browser can't decode, say) fails the playUrl call still waiting on
 * the hold, whose caller falls back to another voice as it does when play() fails without a pause; with no call waiting
 * (a clip paused as it started), the clip is held again then too.
 */
const playHeldClip = (el: HTMLAudioElement): void => {
  const token = player.token;
  el.play().then(() => {
    if (token === player.token) settleHeldPlay();
  }, (error: unknown) => {
    if (token !== player.token || player.state.status !== 'playing') return;
    if (player.heldPlay && !mayPlayLater(error)) {
      setPlaybackState({ status: 'loading' });
      settleHeldPlay({ error });
      return;
    }
    player.pendingPause = true;
    player.armed = true;
    setPlaybackState({ status: 'paused' });
  });
};

/** Resume after pauseCurrent() (no-op unless paused). A read held while it loaded starts, or goes on loading. */
export const resumeCurrent = (): void => {
  if (player.state.status !== 'paused') return;
  const token = player.token;
  if (player.pendingPause) {
    player.pendingPause = false;
    // Still loading: it starts by itself once ready.
    if (!player.armed) { setPlaybackState({ status: 'loading' }); return; }
    player.armed = false;
    // Held at its start, so play whatever its position (resumePlayback's position check would refuse a clip at 0).
    if (player.backend === 'clip') {
      if (audioEl) playHeldClip(audioEl);
    } else {
      try { window.speechSynthesis?.resume(); } catch { /* ignore */ }
    }
    setPlaybackState({ status: 'playing' });
    return;
  }
  resumePlayback(() => {
    // The browser refused (iOS can want a fresh tap after an interruption): it's still paused.
    if (token === player.token && player.state.status === 'playing') setPlaybackState({ status: 'paused' });
  });
  setPlaybackState({ status: 'playing' });
};

/**
 * Stop playback entirely and clear the active text (supersedes the in-flight handle). A live request's owner hears
 * `reason`: 'stopped', or 'style-changed' when a new speech style stops it.
 */
export const stopCurrent = (reason: 'stopped' | 'style-changed' = 'stopped'): void => {
  supersedePlayback(reason);
  stopPlayback();
  setPlaybackState({ text: null, status: 'idle' });
};

subscribePlaybackRate(rate => {
  if (audioEl) {
    audioEl.defaultPlaybackRate = rate;
    audioEl.playbackRate = rate;
  }
});

/**
 * Seek the playing or paused clip to a time offset (seconds) and make sure it's playing. Does nothing unless a
 * clip is the active output: the system voice can't seek.
 */
export const seekCurrent = (timeSec: number): void => {
  const a = audioEl;
  if (!a || player.backend !== 'clip') return;
  // A clip held as it loaded plays from the seek, as a paused one does.
  const held = player.armed;
  player.pendingPause = false;
  player.armed = false;
  try { a.currentTime = Math.max(0, timeSec); } catch { /* ignore */ }
  if (held) playHeldClip(a);
  else if (a.paused && !a.ended) {
    const token = player.token;
    a.play().catch(() => {
      // The browser refused, as it can on iOS after an interruption: it's still paused (see resumeCurrent).
      if (token === player.token && player.state.status === 'playing') setPlaybackState({ status: 'paused' });
    });
  }
  if (player.state.status === 'paused') setPlaybackState({ status: 'playing' });
};

// Apply the global voice speed to the shared <audio> element. preservesPitch keeps a faster rate
// from raising the pitch (chipmunk). Set right before each play(): loading a new src can reset
// playbackRate to defaultPlaybackRate, so we set both. Vendor-prefixed field covers older Safari.
const applyRate = (el: HTMLAudioElement): void => {
  try {
    el.preservesPitch = true;
    (el as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    el.defaultPlaybackRate = getPlaybackRate();
    el.playbackRate = getPlaybackRate();
  } catch { /* ignore */ }
};

/** What playUrl reports back: playback started, reached the end, or failed after it started. */
export interface ClipCallbacks {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: unknown) => void;
}

/**
 * Play an object URL through the shared, iOS-unlocked <audio> element (cached MiMo + Kokoro both use this). It settles
 * with play(), rejecting when the browser won't play the clip, so a caller whose request is still current falls back to
 * another voice. A clip a pause holds waits for the play that ends the hold, or for a newer request or a stop.
 */
export const playUrl = async (
  url: string,
  isCurrent: () => boolean,
  { onStart, onEnd, onError }: ClipCallbacks,
  startAt?: number,
): Promise<void> => {
  const el = getAudioEl();
  let started = false;
  el.onplaying = () => { started = true; if (isCurrent()) onStart?.(); };
  el.onended = () => { if (isCurrent()) onEnd?.(); };
  // A clip that breaks mid-play fails the read rather than finishing it. Before playback starts, a bad clip
  // rejects play() below and the caller falls back to another voice; failing here as well would let the
  // caller move on while that fallback still speaks.
  el.onerror = () => { if (started && isCurrent()) onError?.(el.error ?? new Error('The clip failed while playing')); };
  // A pause the browser or the OS makes (a call, AirPods out, Control Center) shows as paused, so the speakers and the
  // lock screen offer to resume; el.onplaying above shows it playing again when it resumes. The engine's own pause has
  // set 'paused' already, a stop or a newer request has made this one stale, and the pause at the end comes with ended.
  el.onpause = () => { if (isCurrent() && !el.ended && player.state.status === 'playing') setPlaybackState({ status: 'paused' }); };
  el.onloadedmetadata = null;
  const begin = startAt && startAt > 0 ? startAt : 0;
  el.src = url;
  setUrlInUse(url);
  player.backend = 'clip';
  // A pause asked for while this clip loaded leaves it ready but silent, for resumeCurrent() or a seek to play. The call
  // then waits for that play (playHeldClip), failing if the clip can't be played.
  const holdForPause = (): Promise<void> | null => {
    if (!player.pendingPause) return null;
    player.armed = true;
    return new Promise<void>((resolve, reject) => { player.heldPlay = { resolve, reject }; });
  };
  if (begin <= 0) {
    try { el.currentTime = 0; } catch { /* ignore */ }
    applyRate(el);
    const held = holdForPause();
    if (held) return held;
    await el.play();
    return;
  }
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
      const held = holdForPause();
      if (held) { held.then(resolve, reject); return; }
      el.play().then(() => resolve(), reject); // a refused play() falls back, as on the path above
    };
    if (el.readyState >= 1 /* HAVE_METADATA */) go();
    else { el.onloadedmetadata = go; fallbackTimer = setTimeout(go, 1500); } // fallback if metadata stalls
  });
};

/** Read `text` with the system voice as the current request's output. Null when the browser has no speech engine. */
export const playSpeech = (
  text: string,
  options: { rate: number; onStart: () => void; onEnd: () => void; onError: (event: SpeechSynthesisErrorEvent) => void },
): SpeechSynthesisUtterance | null => {
  player.backend = 'speech';
  return systemSpeak(text, options);
};
