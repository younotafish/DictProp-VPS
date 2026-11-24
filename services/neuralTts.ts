/**
 * The speech engine: every sentence read and word pronunciation goes through here.
 *
 * A sentence (speakNatural) plays the best voice available, in this order:
 *  1. the server's cached MiMo clip for the current speech style. audio/clipStore.ts keeps the clips in
 *     memory and in IndexedDB (services/audioCache.ts), so each one downloads once;
 *  2. in the casual style, the clear clip, while the server generates the casual one;
 *  3. on a miss, after asking the server to generate the clip for next time, the in-browser Kokoro voice
 *     everywhere but iOS/iPadOS (audio/neuralVoice.ts: a ~326 MB model, downloaded once, after asking first on
 *     Android, and run in a worker), or the system voice (services/speech.ts) on iOS/iPadOS and wherever Kokoro
 *     is declined or can't run.
 * A sentence from one of its words (speakNaturalAt) plays the sentence's clip from that word, in the same voice.
 * A word (speakWord) always uses the system voice: instant, and fine for one word.
 *
 * audio/player.ts holds the one shared <audio> element, the system voice's controls and the playback state
 * every speaker button shows; audio/keepAlive.ts the silent keep-alive and the background-safe gap timer
 * that auto-play uses; audio/mediaSession.ts the lock-screen controls. Screens import this module directly, so a
 * tap reaches it synchronously; only screens that load on demand import it, which keeps it out of the app's first
 * chunk.
 */
import { speak as systemSpeak, cancelSpeech } from './speech';
import { stripSentenceMarkers } from './sentenceMarkers';
import { requestTTSGeneration } from './api/tts';
import { warn } from './logger';
import { getTtsStyle, getPlaybackRate, subscribeTtsStyle, type TtsStyle } from './ttsSettings';
import { leadInSkip, startAtForOffset } from './ttsAlignment';
import {
  reacquireClipUrl, resolvePlayableClip, resolveTimingsForPlayback, timingsInMemory, type ResolvedCachedClip,
} from './audio/clipStore';
import { setMediaSessionHandlers as applyMediaSessionHandlers, type MediaSessionHandlers } from './audio/mediaSession';
import { speakViaKokoro } from './audio/neuralVoice';
import { isIOS } from './audio/platform';
import {
  currentRequestCheck,
  endPlayback,
  getPlaybackState,
  markPlaying,
  pauseCurrent,
  playSpeech,
  playUrl,
  resumeCurrent,
  seekCurrent,
  setPlaybackState,
  startRequest,
  stopCurrent,
  stopPlayback,
  supersedePlayback,
  unlockAudio,
  type InterruptReason,
} from './audio/player';
import { STYLE_VOICES } from './audio/voices';
export {
  getPlaybackState,
  getPlaybackToken,
  subscribePlayback,
  getPlaybackProgress,
  pauseCurrent,
  resumeCurrent,
  stopCurrent,
  seekCurrent,
  reservePlayback,
  type InterruptReason,
  type PlaybackStatus,
  type PlaybackState,
} from './audio/player';
export { setMediaMetadata, setPlaybackStateOverride, type MediaSessionHandlers } from './audio/mediaSession';
export { primeKeepAlive, acquireKeepAlive, releaseKeepAlive, afterGap } from './audio/keepAlive';
export { ensureTimings } from './audio/clipStore';
export { prefetchTTS, ensureTTS, preloadAudio } from './audio/clipWarmers';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface SpeakHandle {
  /** Stop the playback this handle started, if nothing has superseded it yet. */
  stop: () => void;
  /** True while this handle still owns the engine — i.e. not superseded by a newer speak/word/stop. */
  isActive: () => boolean;
}

export interface SpeakOptions {
  /** Whether a cache miss may start the one-time Kokoro model download (never on iOS/iPadOS, and on Android only
   *  once the user agrees). Defaults to true. */
  allowDownload?: boolean;
  /** Start playback this many seconds into the clip (word-level seek). Cached-clip path only. */
  startAt?: number;
  /** The read reached its end. */
  onEnd?: () => void;
  /** The read failed for good (nothing played it to the end). */
  onError?: (event: unknown) => void;
  /**
   * Something else ended the read before it ended by itself: another sentence or word ('superseded'), a stop from
   * elsewhere ('stopped') or a change of speech style ('style-changed'). Called once, in a microtask; never after the
   * handle's own stop(), the end of the read or its failure.
   */
  onInterrupted?: (reason: InterruptReason) => void;
}

const INACTIVE_HANDLE: SpeakHandle = { stop: () => {}, isActive: () => false };

let activeStyle = getTtsStyle();
subscribeTtsStyle(style => {
  if (style !== activeStyle) {
    activeStyle = style;
    stopCurrent('style-changed');
  }
});

/** Register lock-screen action handlers, or pass null to clear them (and the metadata). */
export const setMediaSessionHandlers = (handlers: MediaSessionHandlers | null): void =>
  applyMediaSessionHandlers(handlers, { play: () => resumeCurrent(), pause: () => pauseCurrent(), stop: () => stopCurrent() });

/** One request's bookkeeping: whether it's still current, and its start, end and failure, reported only while it is. */
interface ReadContext {
  isCurrent: () => boolean;
  markStart: () => void;
  markEnd: () => void;
  markError: (error: unknown) => void;
}

/**
 * Make a new request current, showing `displayText` (stripped and trimmed) loading at once, so every speaker of that
 * sentence shows it from the tap on. Unlocks <audio> inside the gesture (iOS) and stops whatever was playing.
 */
const beginRequest = (displayText: string, opts: SpeakOptions): { read: ReadContext; handle: SpeakHandle } => {
  const { isCurrent, release } = startRequest(opts.onInterrupted);
  // Drive the shared playback state so every speaker UI reflects THIS playback (keyed by text),
  // whatever triggered it. Gated by isCurrent() so a superseded call can't clobber a newer one's state,
  // nor tell its caller it finished: the system voice reports a cancelled utterance as ended or failed,
  // which would record a read that was cut off or carry a stopped autoplay chain on to the next sentence.
  const read: ReadContext = {
    isCurrent,
    markStart: () => { if (!isCurrent()) return; markPlaying(); },
    markEnd: () => { if (!isCurrent()) return; endPlayback(); opts.onEnd?.(); },
    markError: (error: unknown) => { if (!isCurrent()) return; endPlayback(); opts.onError?.(error); },
  };
  unlockAudio();
  stopPlayback();
  setPlaybackState({ text: displayText, status: 'loading' });
  return {
    read,
    handle: {
      // The owner's own stop: let go of onInterrupted first, so stopping its own read never reports an interruption.
      stop: () => { release(); if (isCurrent()) stopCurrent(); },
      isActive: () => isCurrent(),
    },
  };
};

/** Read `plain` with the system voice as the request `read`. */
const readWithSystemVoice = (plain: string, { markStart, markEnd, markError }: ReadContext): void => {
  // A browser without a speech engine would otherwise leave the read loading for good.
  if (!playSpeech(plain, { rate: getPlaybackRate(), onStart: markStart, onEnd: markEnd, onError: markError })) {
    markError(new Error('This browser has no speech engine'));
  }
};

/**
 * Read `plain`, which has no clip, as the request `read`: by the Kokoro voice everywhere but iOS/iPadOS, when its model
 * is loaded or `allowDownload` lets this read start the one-time download; otherwise, or when Kokoro is declined or
 * fails, by the system voice.
 */
const readWithoutClip = async (plain: string, read: ReadContext, allowDownload: boolean): Promise<void> => {
  const systemFallback = () => readWithSystemVoice(plain, read);
  if (isIOS()) { systemFallback(); return; }
  const { isCurrent, markStart, markEnd, markError } = read;
  await speakViaKokoro(plain, { onStart: markStart, onEnd: markEnd, onError: markError, allowDownload }, isCurrent, systemFallback);
};

/** How readText reads: from where in the clip, and whether a miss may start the Kokoro download. */
interface ReadPlan {
  startAt?: number;
  allowDownload: boolean;
}

/** Read `plain` with the best voice there is (the order at the top of this file) as the request `read`, in `style`. */
const readText = async (plain: string, style: TtsStyle, read: ReadContext, plan: ReadPlan): Promise<void> => {
  const { isCurrent, markStart, markEnd, markError } = read;
  // Ask the server to make the clip (or its timings) that's missing, for next time.
  const generate = (voice: string) => {
    requestTTSGeneration([{ text: plain, voice }]).catch(() => { /* best-effort */ });
  };

  // Resolve per-word timings to trim the quiet lead-in, but WITHOUT blocking the tap on the fetch: we
  // already hold the audio, so a slow/stalled timings round-trip must not hold up playback (the "takes
  // forever to load" bug). Warm timings are instant; a cold miss waits only a short budget, then plays now
  // while the fetch keeps warming in the background for the next play / tap-to-seek.
  const playClip = async (clip: ResolvedCachedClip, onGenuineMiss: () => void): Promise<void> => {
    const timings = await resolveTimingsForPlayback(clip.key, onGenuineMiss);
    const url = await reacquireClipUrl(clip);
    if (!isCurrent()) return;
    activeClip = { key: clip.key, isCurrent };
    // Caller-specified start (word-level seek) wins; otherwise auto-skip the quiet lead-in.
    const begin = plan.startAt && plan.startAt > 0 ? plan.startAt : leadInSkip(timings);
    await playUrl(url, isCurrent, { onStart: markStart, onEnd: markEnd, onError: markError }, begin);
  };

  try {
    // 1) memory → 2) IndexedDB → 3) server, with a version-specific fallback when configured. A casual MISS queues
    // its generation but doesn't make the user wait: the (essentially always-cached) CLEAR clip plays meanwhile.
    const clip = await resolvePlayableClip(plain, style, {
      onStyleMiss: () => { if (style === 'casual') generate(STYLE_VOICES.casual.generate); },
      stillWanted: isCurrent,
    });
    if (!isCurrent()) return;
    if (clip) {
      // loadClipUrl already inserted/touched the in-memory entry as most-recently-used.
      await playClip(clip, () => {
        // Imported offline clips include timings; a live-generated production/fallback clip can be repaired here.
        // No backfill on the clear clip standing in for a casual one.
        if (!clip.fallback && clip.token === STYLE_VOICES[style].generate) generate(clip.token);
      });
      return;
    }

    // 3) MISS — fill the clear cache for next time (fire-and-forget), then fall back now (no timings).
    generate(STYLE_VOICES.clear.generate);
    await readWithoutClip(plain, read, plan.allowDownload);
  } catch (err) {
    if (!isCurrent()) return;
    warn('🔊 TTS chain failed, falling back to system voice', err);
    readWithSystemVoice(plain, read);
  }
};

/**
 * Speak `text` with the best available voice (see the order at the top of this file). A miss never waits for
 * the ~2.75 s generation it requests. Returns a handle whose stop() stops whichever output ends up playing.
 */
export const speakNatural = (text: string, opts: SpeakOptions = {}): SpeakHandle => {
  const plain = stripSentenceMarkers(text).trim();
  if (!plain) return INACTIVE_HANDLE;
  const { read, handle } = beginRequest(plain, opts);
  // Capture the style for THIS call so a mid-play toggle can't switch tracks underneath it.
  void readText(plain, getTtsStyle(), read, { startAt: opts.startAt, allowDownload: opts.allowDownload ?? true });
  return handle;
};

/** How speakNaturalAt plays from a word. It never starts the Kokoro download, and never has a fragment's clip made. */
export interface SpeakAtOptions extends Omit<SpeakOptions, 'startAt' | 'allowDownload'> {
  /**
   * Only move the sentence's clip, if it's the one playing or paused, to the word; never start a read. Auto-play's
   * chain owns the audio while it runs, so a word tap then only seeks its clip.
   */
  seekOnly?: boolean;
}

/** The handle of the request playing now, for a call that acts on it instead of starting one. */
const currentRequestHandle = (): SpeakHandle => {
  const isCurrent = currentRequestCheck();
  return { stop: () => { if (isCurrent()) stopCurrent(); }, isActive: isCurrent };
};

// The clip the current request plays, always one of the sentence it shows, so a word tap can find its timings at once.
// Only while that request is current.
let activeClip: { key: string; isCurrent: () => boolean } | null = null;

/**
 * Play the sentence `fullText` from the word at `charOffset`, a character index in the sentence as shown (markers
 * stripped, HighlightedSentence's data-word-offset). The speakers show the whole sentence loading from the tap on. When
 * the sentence's clip is already playing or paused, it moves there in place. Otherwise the sentence's own clip (the one
 * speakNatural would play, in its voice) starts at the word, once its timings arrive within 400 ms. Without them the
 * rest of the sentence from the word is read at once, still shown as the whole sentence: no clip of it exists, so none
 * is looked up, it's read by the system voice (or Kokoro, if its model is already loaded), and the server is asked for
 * the whole sentence's clip rather than the fragment's. It never starts the Kokoro download.
 */
export const speakNaturalAt = (fullText: string, charOffset: number, opts: SpeakAtOptions = {}): SpeakHandle => {
  const shown = stripSentenceMarkers(fullText);
  const plain = shown.trim();
  if (!plain) return INACTIVE_HANDLE;
  const style = getTtsStyle();
  const remainder = shown.slice(Math.max(0, charOffset)).trim() || plain;

  // Already this sentence's clip, with its timings in hand (they arrive while it plays): move it to the word in place.
  const state = getPlaybackState();
  if (state.text === plain && (state.status === 'playing' || state.status === 'paused') && activeClip?.isCurrent()) {
    const startAt = startAtForOffset(shown, timingsInMemory(activeClip.key), charOffset);
    if (startAt !== null) {
      seekCurrent(startAt);
      return currentRequestHandle();
    }
  }
  if (opts.seekOnly) return INACTIVE_HANDLE;

  const { read, handle } = beginRequest(plain, opts);
  const readRemainder = () => readWithoutClip(remainder, read, false);
  void (async () => {
    try {
      const clip = await resolvePlayableClip(plain, style, { stillWanted: read.isCurrent });
      if (!read.isCurrent()) return;
      if (!clip) {
        // No clip in any voice: ask for the whole sentence's, as speakNatural does on a miss, and read the rest now.
        requestTTSGeneration([{ text: plain, voice: STYLE_VOICES.clear.generate }]).catch(() => { /* best-effort */ });
        await readRemainder();
        return;
      }
      const timings = await resolveTimingsForPlayback(clip.key, () => {
        if (!clip.fallback && clip.token === STYLE_VOICES[style].generate) {
          requestTTSGeneration([{ text: plain, voice: clip.token }]).catch(() => { /* best-effort */ });
        }
      });
      const startAt = startAtForOffset(shown, timings, charOffset);
      if (!read.isCurrent()) return;
      if (startAt === null) { await readRemainder(); return; }
      const url = await reacquireClipUrl(clip);
      if (!read.isCurrent()) return;
      activeClip = { key: clip.key, isCurrent: read.isCurrent };
      await playUrl(url, read.isCurrent, { onStart: read.markStart, onEnd: read.markEnd, onError: read.markError }, startAt);
    } catch (err) {
      if (!read.isCurrent()) return;
      warn('🔊 Play from a word failed, reading the rest instead', err);
      await readRemainder();
    }
  })();
  return handle;
};

/**
 * Speak a single word / card title (the item itself) with the BUILT-IN system voice — instant,
 * free, and fine for one word. Only example SENTENCES use the cached MiMo voice (speakNatural).
 * Stops any cached/Kokoro sentence first so a word tap interrupts cleanly.
 */
export const speakWord = (text: string): SpeakHandle => {
  const plain = stripSentenceMarkers(text).trim();
  const isCurrent = supersedePlayback();              // supersede any active sentence handle
  setPlaybackState({ text: null, status: 'idle' });   // a word isn't shown by any speaker button → clear them
  stopPlayback();
  systemSpeak(plain);
  return {
    stop: () => {
      if (!isCurrent()) return;
      supersedePlayback();
      cancelSpeech();
    },
    isActive: () => isCurrent() && typeof window !== 'undefined' && !!(window.speechSynthesis?.speaking || window.speechSynthesis?.paused),
  };
};
