import {
  ttsKey, fetchCachedClipByKey, fetchCachedTimingsByKey, requestTTSGeneration, type CachedLookup, type CachedLookupOptions,
  type WordTiming,
} from '../api/tts';
import { getAudioBlob, putAudioBlob, getTimings, putTimings } from '../audioCache';
import { stripSentenceMarkers } from '../sentenceMarkers';
import { getTtsStyle, type TtsStyle } from '../ttsSettings';
import { Lru, MAX_TIMINGS, MAX_TTS_URLS, UrlLru } from './urlLru';
import { STYLE_VOICES } from './voices';

// Device-local cache of ready-to-play object URLs (cached MiMo clips, keyed by ttsKey hash) — replays are instant.
const ttsUrlCache = new UrlLru(MAX_TTS_URLS);
// Per-word timings for cached clips, keyed by the SAME ttsKey hash (parallel to ttsUrlCache).
const ttsTimingsCache = new Lru<WordTiming[]>(MAX_TIMINGS);

// ── Durable clip acquisition — the offline audio cache seam ──────────────────────
// Every clip/timing lookup funnels through these two helpers, which check the caches in order of speed:
//   in-memory Map (this session) → IndexedDB (survives launches, services/audioCache.ts) → server.
// A server hit is written through to IndexedDB so the NEXT launch loads it from local disk instead of
// re-downloading — the whole point of the cache (clips are content-addressed + immutable, so a stored
// blob is valid forever). The returned object URL is inserted into the existing bounded-LRU `ttsUrlCache`
// (which revokes evicted URLs), so in-session memory management is unchanged — IDB is purely a durable
// layer beneath it. Both are best-effort: an unavailable IDB (private mode) just falls through to network.
// A lookup already under way is shared, so tapping a sentence whose clip is still prefetching joins that
// download instead of starting a second one from scratch. So is the download itself (fetchClipShared,
// fetchTimingsShared), which a session warm storing clips straight into IndexedDB (clipWarmers.ts) also goes
// through: the warm joins a download playback started, and playback joins one the warm started. A warm that stops
// lets go of its downloads; one is aborted only once nobody waits for it, so a stop never cuts off playback's.
const clipLoads = new Map<string, Promise<string | null>>();
const timingsLoads = new Map<string, Promise<WordTiming[] | null>>();

interface SharedFetch<T> {
  promise: Promise<CachedLookup<T>>;
  abort: AbortController;
  /** Waiters that may still give up (they came with a signal). */
  abortable: number;
  /** A waiter without a signal (playback) joined: the download always runs to its end. */
  pinned: boolean;
}
const clipFetches = new Map<string, SharedFetch<Blob>>();
const timingsFetches = new Map<string, SharedFetch<WordTiming[]>>();
const GAVE_UP = { kind: 'failed' } as const;

/**
 * `fetch(key)`, or the call of it for `key` already under way. A waiter with `signal` stops waiting when it aborts,
 * as failed; the download itself is aborted once every waiter has given up, unless one came without a signal.
 */
const joinFetch = <T>(
  fetches: Map<string, SharedFetch<T>>,
  key: string,
  fetch: (key: string, options: CachedLookupOptions) => Promise<CachedLookup<T>>,
  signal?: AbortSignal,
): Promise<CachedLookup<T>> => {
  if (signal?.aborted) return Promise.resolve(GAVE_UP);
  let entry = fetches.get(key);
  if (!entry) {
    const abort = new AbortController();
    const created: SharedFetch<T> = { promise: fetch(key, { signal: abort.signal }), abort, abortable: 0, pinned: false };
    const forget = () => { if (fetches.get(key) === created) fetches.delete(key); };
    created.promise.then(forget, forget);
    fetches.set(key, created);
    entry = created;
  }
  if (!signal) {
    entry.pinned = true;
    return entry.promise;
  }
  const joined = entry;
  joined.abortable++;
  return new Promise<CachedLookup<T>>((resolve) => {
    const giveUp = () => {
      joined.abortable--;
      if (!joined.pinned && joined.abortable === 0) {
        // Nobody waits for it any more: stop it, and let the next request start afresh.
        if (fetches.get(key) === joined) fetches.delete(key);
        joined.abort.abort();
      }
      resolve(GAVE_UP);
    };
    signal.addEventListener('abort', giveUp, { once: true });
    void joined.promise.then((result) => {
      signal.removeEventListener('abort', giveUp);
      resolve(result);
    });
  });
};

/** Clip `key` from the server, `missing` only on a 404, joining a download of it already under way (see joinFetch). */
export const fetchClipShared = (key: string, signal?: AbortSignal): Promise<CachedLookup<Blob>> =>
  joinFetch(clipFetches, key, fetchCachedClipByKey, signal);
/** Clip `key`'s word timings from the server, `missing` only on a 404, joining a download already under way. */
export const fetchTimingsShared = (key: string, signal?: AbortSignal): Promise<CachedLookup<WordTiming[]>> =>
  joinFetch(timingsFetches, key, fetchCachedTimingsByKey, signal);
const valueOf = <T>(lookup: CachedLookup<T>): T | null => (lookup.kind === 'hit' ? lookup.value : null);

/** Whether clip `key` is open in memory, without counting as a use. */
export const hasClipInMemory = (key: string): boolean => ttsUrlCache.has(key);
/** Whether clip `key`'s timings are in memory, without counting as a use. */
export const hasTimingsInMemory = (key: string): boolean => ttsTimingsCache.has(key);
/** Clip `key`'s timings if they're in memory, at once; null otherwise. */
export const timingsInMemory = (key: string): WordTiming[] | null => ttsTimingsCache.get(key) ?? null;

/** Ready-to-play object URL for clip `key` (memory → IDB → server, write-through). Null on a true miss. */
export const loadClipUrl = (key: string): Promise<string | null> => {
  const mem = ttsUrlCache.get(key); // a hit marks the clip most recently used
  if (mem) return Promise.resolve(mem);
  const pending = clipLoads.get(key);
  if (pending) return pending;
  const load = (async () => {
    const stored = await getAudioBlob(key);
    if (stored) {
      const url = URL.createObjectURL(stored);
      ttsUrlCache.set(key, url);
      return url;
    }
    const blob = valueOf(await fetchClipShared(key));
    if (!blob) return null;
    void putAudioBlob(key, blob); // write-through (fire-and-forget; never blocks playback)
    const url = URL.createObjectURL(blob);
    ttsUrlCache.set(key, url);
    return url;
  })().finally(() => clipLoads.delete(key));
  clipLoads.set(key, load);
  return load;
};

export interface ResolvedCachedClip { key: string; url: string; token: string }

/** The first of the style's clips (best voice first) the device or the server has. Null when none exists. */
export const resolveCachedClip = async (text: string, style: TtsStyle): Promise<ResolvedCachedClip | null> => {
  for (const token of STYLE_VOICES[style].play) {
    const key = await ttsKey(text, token);
    const url = await loadClipUrl(key);
    if (url) return { key, url, token };
  }
  return null;
};

/** The clip a sentence plays: the style's own, or in the casual style the clear one standing in for it (`fallback`). */
export interface PlayableClip extends ResolvedCachedClip { fallback: boolean }

export interface PlayableClipOptions {
  /** Runs when the style's own clip is missing, before the casual style looks for the clear one. */
  onStyleMiss?: () => void;
  /** Checked after the first lookup: once it's false, the lookup stops there and finds nothing. */
  stillWanted?: () => boolean;
}

/**
 * The clip speakNatural plays for `text` in `style`: the style's own clip, else in the casual style the clear clip,
 * while the server makes the casual one. Decided by which clip exists, not which timings do, so word timings looked
 * up through it always belong to the clip that plays. Null when neither exists.
 */
export const resolvePlayableClip = async (
  text: string,
  style: TtsStyle,
  { onStyleMiss, stillWanted = () => true }: PlayableClipOptions = {},
): Promise<PlayableClip | null> => {
  const own = await resolveCachedClip(text, style);
  if (own) return { ...own, fallback: false };
  if (!stillWanted()) return null;
  onStyleMiss?.();
  if (style !== 'casual') return null;
  const clear = await resolveCachedClip(text, 'clear');
  return clear ? { ...clear, fallback: true } : null;
};

/** Per-word timings for clip `key` (memory → IDB → server, write-through). Null when none exist. */
export const loadTimingsCached = (key: string): Promise<WordTiming[] | null> => {
  const mem = ttsTimingsCache.get(key);
  if (mem) return Promise.resolve(mem);
  const pending = timingsLoads.get(key);
  if (pending) return pending;
  const load = (async () => {
    const stored = await getTimings(key);
    if (stored && stored.length) { ttsTimingsCache.set(key, stored); return stored; }
    const t = valueOf(await fetchTimingsShared(key));
    if (t && t.length) { void putTimings(key, t); ttsTimingsCache.set(key, t); return t; }
    return null;
  })().finally(() => timingsLoads.delete(key));
  timingsLoads.set(key, load);
  return load;
};


/** Word timings for the clip speakNatural plays for `text` in the current style (resolvePlayableClip: in the casual style
 *  the clear clip stands in for a missing casual one), so a seek or a highlight lines up with what's heard. Null when
 *  there's no clip or it has no timings. */
export const getTimingsFor = async (text: string): Promise<WordTiming[] | null> => {
  const plain = stripSentenceMarkers(text).trim();
  if (!plain) return null;
  const clip = await resolvePlayableClip(plain, getTtsStyle());
  return clip ? loadTimingsCached(clip.key) : null;
};

/** Ensure word timings exist for the current style's own clip of `text`: warm them if present, else kick off background
 *  generation (whisper cold-start is ~a minute, so call this when a sentence is shown, not at click). The casual style's
 *  clear stand-in doesn't count, so a missing casual clip is still asked for. */
export const ensureTimings = async (text: string): Promise<void> => {
  const plain = stripSentenceMarkers(text).trim();
  if (!plain) return;
  const style = getTtsStyle();
  for (const token of STYLE_VOICES[style].play) {
    if (await loadTimingsCached(await ttsKey(plain, token))) return;
  }
  requestTTSGeneration([{ text: plain, voice: STYLE_VOICES[style].generate }]).catch(() => { /* best-effort backfill */ });
};

// Resolve word timings for playback WITHOUT letting a cold/slow network stall the tap. Trimming the
// ~100ms lead-in is a nice-to-have; the audio clip is already in hand, so a slow (or wedged, un-timed-out)
// timings round-trip must NEVER hold up playback — that is the "sentence audio takes forever to load even
// on good 5G" bug (a second sequential fetch was awaited before every cold play). Returns warm timings
// instantly; on a device-cache miss it waits only TIMINGS_WAIT_MS for the server, then resolves so the clip
// plays NOW while the fetch keeps running in the background — caching whatever lands so the next play /
// tap-to-seek has it. onGenuineMiss fires whenever the lookup ends without timings: on the server's 404, but also
// on the fetch's own 6 s timeout or a network error, so offline every play of such a clip requests them again.
const TIMINGS_WAIT_MS = 400;
export const resolveTimingsForPlayback = async (
  key: string,
  onGenuineMiss: () => void,
): Promise<WordTiming[] | null> => {
  const cached = ttsTimingsCache.get(key);
  if (cached) return cached;
  // memory missed → look up IDB (fast, local) then the server; the whole lookup is raced against a short
  // budget so a slow NETWORK fetch never holds up playback. onGenuineMiss fires once the lookup itself ends empty.
  const lookupP = loadTimingsCached(key).catch(() => null).then((t) => {
    if (!t) onGenuineMiss(); // server has no timings yet → backfill for next time (runs even if we didn't wait)
    return t;
  });
  const winner = await Promise.race([
    lookupP,
    new Promise<WordTiming[] | null>((r) => setTimeout(() => r(null), TIMINGS_WAIT_MS)),
  ]);
  return winner && winner.length ? winner : null;
};

// Clips loading meanwhile (prefetch, preload) can evict — and so revoke — a clip's URL while its timings
// are awaited, so look it up again right before playing it.
export const reacquireClipUrl = async (clip: ResolvedCachedClip): Promise<string> =>
  (await loadClipUrl(clip.key).catch(() => null)) ?? clip.url;
