/**
 * The speech engine: every sentence read and word pronunciation goes through here.
 *
 * A sentence (speakNatural) plays the best voice available, in this order:
 *  1. the server's cached MiMo clip for the current speech style. audio/clipStore.ts keeps the clips in
 *     memory and in IndexedDB (services/audioCache.ts), so each one downloads once;
 *  2. in the casual style, the clear clip, while the server generates the casual one;
 *  3. on a miss, after asking the server to generate the clip for next time, the in-browser Kokoro voice
 *     on desktop (audio/neuralVoice.ts: a ~326 MB model, downloaded once and run in a worker), or the
 *     system voice (services/speech.ts) on iOS/iPadOS and wherever Kokoro can't run.
 * A word (speakWord) always uses the system voice: instant, and fine for one word.
 *
 * audio/player.ts holds the one shared <audio> element, the system voice's controls and the playback state
 * every speaker button shows; audio/keepAlive.ts the silent keep-alive and the background-safe gap timer
 * that auto-play uses; audio/mediaSession.ts the lock-screen controls. Screens load this module through
 * services/lazyTts.ts.
 */
import { speak as systemSpeak, cancelSpeech } from './speech';
import { stripSentenceMarkers } from './sentenceMarkers';
import { requestTTSGeneration } from './api';
import { warn } from './logger';
import { getTtsStyle, getPlaybackRate, subscribeTtsStyle } from './ttsSettings';
import { leadInSkip } from './ttsAlignment';
import { reacquireClipUrl, resolveCachedClip, resolveTimingsForPlayback, type ResolvedCachedClip } from './audio/clipStore';
import { setMediaSessionHandlers as applyMediaSessionHandlers, type MediaSessionHandlers } from './audio/mediaSession';
import { speakViaKokoro } from './audio/neuralVoice';
import { isIOS } from './audio/platform';
import {
  endPlayback,
  pauseCurrent,
  playSpeech,
  playUrl,
  resumeCurrent,
  setPlaybackState,
  stopCurrent,
  stopPlayback,
  supersedePlayback,
  unlockAudio,
} from './audio/player';
import { STYLE_VOICES } from './audio/voices';
export {
  getPlaybackState,
  subscribePlayback,
  getPlaybackProgress,
  pauseCurrent,
  resumeCurrent,
  stopCurrent,
  seekCurrent,
  type PlaybackStatus,
  type PlaybackState,
} from './audio/player';
export { setMediaMetadata, type MediaSessionHandlers } from './audio/mediaSession';
export { primeKeepAlive, acquireKeepAlive, releaseKeepAlive, afterGap } from './audio/keepAlive';
export { getTimingsFor, ensureTimings } from './audio/clipStore';
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
  /** Whether a cache miss may start the one-time Kokoro model download (desktop only). Defaults to true. */
  allowDownload?: boolean;
  /** Start playback this many seconds into the clip (word-level seek). Cached-clip path only. */
  startAt?: number;
  /** The read reached its end. */
  onEnd?: () => void;
  /** The read failed for good (nothing played it to the end). */
  onError?: (event: unknown) => void;
}

const INACTIVE_HANDLE: SpeakHandle = { stop: () => {}, isActive: () => false };

let activeStyle = getTtsStyle();
subscribeTtsStyle(style => {
  if (style !== activeStyle) {
    activeStyle = style;
    stopCurrent();
  }
});

/** Register lock-screen action handlers, or pass null to clear them (and the metadata). */
export const setMediaSessionHandlers = (handlers: MediaSessionHandlers | null): void =>
  applyMediaSessionHandlers(handlers, { play: () => resumeCurrent(), pause: () => pauseCurrent(), stop: () => stopCurrent() });

/**
 * Speak `text` with the best available voice (see the order at the top of this file). A miss never waits for
 * the ~2.75 s generation it requests. Returns a handle whose stop() stops whichever output ends up playing.
 */
export const speakNatural = (text: string, opts: SpeakOptions = {}): SpeakHandle => {
  const plain = stripSentenceMarkers(text).trim();
  if (!plain) return INACTIVE_HANDLE;

  const { startAt, onEnd, onError, allowDownload = true } = opts;
  const isCurrent = supersedePlayback();

  // Drive the shared playback state so every speaker UI reflects THIS playback (keyed by text),
  // whatever triggered it. Gated by isCurrent() so a superseded call can't clobber a newer one's state,
  // nor tell its caller it finished: the system voice reports a cancelled utterance as ended or failed,
  // which would record a read that was cut off or carry a stopped autoplay chain on to the next sentence.
  const markStart = () => { if (!isCurrent()) return; setPlaybackState({ status: 'playing' }); };
  const markEnd = () => { if (!isCurrent()) return; endPlayback(); onEnd?.(); };
  const markError = (e: unknown) => { if (!isCurrent()) return; endPlayback(); onError?.(e); };
  const systemFallback = () => playSpeech(plain, { rate: getPlaybackRate(), onStart: markStart, onEnd: markEnd, onError: markError });

  // Resolve per-word timings to trim the quiet lead-in, but WITHOUT blocking the tap on the fetch: we
  // already hold the audio, so a slow/stalled timings round-trip must not hold up playback (the "takes
  // forever to load" bug). Warm timings are instant; a cold miss waits only a short budget, then plays now
  // while the fetch keeps warming in the background for the next play / tap-to-seek.
  const playClip = async (clip: ResolvedCachedClip, onGenuineMiss: () => void): Promise<void> => {
    const timings = await resolveTimingsForPlayback(clip.key, onGenuineMiss);
    const url = await reacquireClipUrl(clip);
    if (!isCurrent()) return;
    // Caller-specified start (word-level seek) wins; otherwise auto-skip the quiet lead-in.
    const begin = startAt && startAt > 0 ? startAt : leadInSkip(timings);
    await playUrl(url, isCurrent, markStart, markEnd, begin);
  };

  // Unlock <audio> synchronously inside the gesture (iOS) and stop anything currently playing.
  unlockAudio();
  stopPlayback();
  setPlaybackState({ text: plain, status: 'loading' });

  // Capture the style for THIS call so a mid-play toggle can't switch tracks underneath it.
  const style = getTtsStyle();

  (async () => {
    try {
      // 1) memory → 2) IndexedDB → 3) server, with a version-specific fallback when configured.
      const clip = await resolveCachedClip(plain, style);
      if (!isCurrent()) return;
      if (clip) {
        // loadClipUrl already inserted/touched the in-memory entry as most-recently-used.
        await playClip(clip, () => {
          // Imported offline clips include timings; a live-generated production/fallback clip can be repaired here.
          if (clip.token === STYLE_VOICES[style].generate) {
            requestTTSGeneration([{ text: plain, voice: clip.token }]).catch(() => {});
          }
        });
        return;
      }

      // Casual MISS → queue its generation, but don't make the user wait: fall back to the
      // (essentially always-cached) CLEAR clip right now so the sentence still plays immediately.
      if (style === 'casual') {
        requestTTSGeneration([{ text: plain, voice: STYLE_VOICES.casual.generate }]).catch(() => { /* best-effort */ });
        const clearClip = await resolveCachedClip(plain, 'clear');
        if (!isCurrent()) return;
        if (clearClip) {
          await playClip(clearClip, () => {}); // no backfill on the fallback clip
          return;
        }

        // clear also absent → fall through to the generic miss path below
      }

      // 3) MISS — fill the clear cache for next time (fire-and-forget), then fall back now (no timings).
      requestTTSGeneration([{ text: plain, voice: STYLE_VOICES.clear.generate }]).catch(() => { /* best-effort */ });
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
