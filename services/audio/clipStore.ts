import { ttsKey, fetchCachedTTS, fetchCachedTTSTimings, requestTTSGeneration, type WordTiming } from '../api';
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
// download instead of starting a second one from scratch.
const clipLoads = new Map<string, Promise<string | null>>();
const timingsLoads = new Map<string, Promise<WordTiming[] | null>>();

/** Ready-to-play object URL for clip `key` (memory → IDB → server, write-through). Null on a true miss. */
const loadClipUrl = (key: string): Promise<string | null> => {
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
    const blob = await fetchCachedTTS(key);
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

/** Per-word timings for clip `key` (memory → IDB → server, write-through). Null when none exist. */
const loadTimingsCached = (key: string): Promise<WordTiming[] | null> => {
  const mem = ttsTimingsCache.get(key);
  if (mem) return Promise.resolve(mem);
  const pending = timingsLoads.get(key);
  if (pending) return pending;
  const load = (async () => {
    const stored = await getTimings(key);
    if (stored && stored.length) { ttsTimingsCache.set(key, stored); return stored; }
    const t = await fetchCachedTTSTimings(key);
    if (t && t.length) { void putTimings(key, t); ttsTimingsCache.set(key, t); return t; }
    return null;
  })().finally(() => timingsLoads.delete(key));
  timingsLoads.set(key, load);
  return load;
};


/** Word timings for the CURRENT style's clip of `text` (device cache or server). Null if none exist.
 *  Both styles have timings now, so word-seek works on clear AND casual (keyed by the active style). */
export const getTimingsFor = async (text: string): Promise<WordTiming[] | null> => {
  const plain = stripSentenceMarkers(text).trim();
  if (!plain) return null;
  for (const token of STYLE_VOICES[getTtsStyle()].play) {
    const timings = await loadTimingsCached(await ttsKey(plain, token));
    if (timings) return timings;
  }
  return null;
};

/** Ensure word timings exist for `text` (current style): warm them if present, else kick off background
 *  generation (whisper cold-start is ~a minute, so call this when a sentence is shown, not at click). */
export const ensureTimings = async (text: string): Promise<void> => {
  const t = await getTimingsFor(text);
  if (t) return;
  const plain = stripSentenceMarkers(text).trim();
  if (plain) requestTTSGeneration([{ text: plain, voice: STYLE_VOICES[getTtsStyle()].generate }]).catch(() => { /* best-effort backfill */ });
};

/**
 * Prefetch cached clips for the given texts into the device-local cache so a later tap is instant
 * (and plays through the iOS-unlocked <audio> element, avoiding the gesture-after-await problem).
 * Fetch-only — never triggers generation.
 */
export const prefetchTTS = (texts: string[]): void => {
  const style = getTtsStyle();
  for (const raw of texts) {
    const plain = stripSentenceMarkers(raw || '').trim();
    if (!plain) continue;
    (async () => {
      const clip = await resolveCachedClip(plain, style);
      if (clip) await loadTimingsCached(clip.key);
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
    const style = getTtsStyle();
    const plains = Array.from(new Set(texts.map(t => stripSentenceMarkers(t || '').trim()).filter(Boolean)));
    if (!plains.length) return;

    // Pull anything already cached (memory → IDB → server) into the device cache; collect true misses.
    const missing: string[] = [];
    await Promise.all(plains.map(async (plain) => {
      if (!(await resolveCachedClip(plain, style))) missing.push(plain);
    }));
    if (missing.length) {
      // Generate the missing clips server-side (one batch), then pull them into the device cache.
      const generationToken = STYLE_VOICES[style].generate;
      await requestTTSGeneration(missing.map(text => ({ text, voice: generationToken })));
      await Promise.all(missing.map(async (plain) => { await loadClipUrl(await ttsKey(plain, generationToken)); }));
    }
    // Warm per-word timings (both styles have them now) so tap-to-seek is ready on the first tap.
    await Promise.all(plains.map(async (plain) => {
      const clip = await resolveCachedClip(plain, style);
      if (clip) await loadTimingsCached(clip.key);
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
  const style = getTtsStyle();
  const plains = Array.from(new Set(texts.map(t => stripSentenceMarkers(t || '').trim()).filter(Boolean)));
  const total = plains.length;
  onProgress?.(0, total);
  if (!total) return;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  // 1) Pull anything already cached (memory → IDB → server) + warm its timings; collect true misses.
  const missing: string[] = [];
  await Promise.all(plains.map(async (plain) => {
    try {
      const clip = await resolveCachedClip(plain, style);
      if (clip) { await loadTimingsCached(clip.key); tick(); return; }
      missing.push(plain); // absent everywhere → generate below
    } catch { tick(); }
  }));

  // 2) Generate the missing clips server-side (one batch), then pull them into the device cache.
  if (missing.length) {
    const generationToken = STYLE_VOICES[style].generate;
    try { await requestTTSGeneration(missing.map(text => ({ text, voice: generationToken }))); } catch { /* best-effort */ }
    await Promise.all(missing.map(async (plain) => {
      try {
        const key = await ttsKey(plain, generationToken);
        await loadClipUrl(key);
        await loadTimingsCached(key);
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
export const leadInSkip = (timings: WordTiming[] | null): number => {
  const first = timings?.[0]?.start;
  return first && isFinite(first) ? Math.max(0, first - LEAD_IN_PREROLL) : 0;
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
