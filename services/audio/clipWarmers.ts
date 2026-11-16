// Batch warm-ups: fetching the clips (and word timings) of many sentences ahead of a tap, so a later play is
// instant and an unstable network can't interrupt a session. One bounded, abortable routine serves the three
// public entry points below.
import { requestTTSGeneration, ttsKey } from '../api';
import { audioCacheReady, getStoredAudioKeys, getStoredTimingKeys, markAudioUsed, putAudioBlob, putTimings } from '../audioCache';
import { stripSentenceMarkers } from '../sentenceMarkers';
import { getTtsStyle, type TtsStyle } from '../ttsSettings';
import {
  fetchClipOnce, fetchTimingsOnce, hasClipInMemory, hasTimingsInMemory, loadClipUrl, loadTimingsCached, resolveCachedClip,
} from './clipStore';
import { STYLE_VOICES } from './voices';

/** Clips a warm-up fetches at once, like the session preload's pictures: enough to keep the line busy without
 *  queueing hundreds of requests ahead of the clip the learner taps next. A warm-up into memory also fetches the
 *  timings of the clips it found, as many at once, beside them. */
export const WARM_CONCURRENCY = 4;

export interface WarmOptions {
  /** Ask the server to generate the clips it doesn't have (one batch), then fetch them. */
  generate?: boolean;
  /** Open each clip as a ready-to-play object URL, for a handful of sentences the learner is about to reach. A
   *  whole session goes to IndexedDB only, unless IndexedDB is unavailable. */
  intoMemory?: boolean;
  /** Progress over the de-duplicated sentences; one that fails still counts as done. */
  onProgress?: (done: number, total: number) => void;
  /** Once aborted, no new clip is fetched or generated. */
  signal?: AbortSignal;
}

/** Run `work` over `items`, at most `limit` at a time, until they run out or `signal` aborts. */
const eachLimited = async <T>(items: readonly T[], limit: number, signal: AbortSignal | undefined, work: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

// A clip, then its timings, from the server straight into IndexedDB: no object URL, so nothing to evict. A download
// playback started is joined rather than repeated, and timings playback already holds aren't fetched again (it
// stores what it fetches too).
const storeTimings = async (key: string): Promise<void> => {
  if (hasTimingsInMemory(key)) return;
  const timings = await fetchTimingsOnce(key);
  if (timings && timings.length) await putTimings(key, timings);
};
const storeClip = async (key: string): Promise<boolean> => {
  const blob = await fetchClipOnce(key);
  if (!blob) return false;
  await putAudioBlob(key, blob);
  await storeTimings(key);
  return true;
};

/**
 * Warm the clips and word timings of `texts` in the current speech style. Each sentence counts once. Small
 * warm-ups resolve every clip as a tap would (memory → IndexedDB → server) and keep it open in memory; a
 * whole session checks IndexedDB for all of them at once and downloads only what's missing.
 */
export const warmClips = async (texts: string[], options: WarmOptions = {}): Promise<void> => {
  const { generate = false, onProgress, signal } = options;
  const style = getTtsStyle();
  const plains = Array.from(new Set(texts.map(t => stripSentenceMarkers(t || '').trim()).filter(Boolean)));
  const total = plains.length;
  onProgress?.(0, total);
  if (!total) return;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  const intoMemory = options.intoMemory || !(await audioCacheReady());
  const { missing, timingsWarmed } = intoMemory
    ? await warmIntoMemory(plains, style, tick, signal)
    : { missing: await warmIntoStorage(plains, style, tick, signal), timingsWarmed: Promise.resolve() };

  // Generate the missing clips server-side (one batch), then fetch them.
  const fetchGenerated = async (): Promise<void> => {
    if (!generate || !missing.length || signal?.aborted) return;
    const voice = STYLE_VOICES[style].generate;
    try { await requestTTSGeneration(missing.map(text => ({ text, voice }))); } catch { /* best-effort */ }
    await eachLimited(missing, WARM_CONCURRENCY, signal, async (plain) => {
      try {
        const key = await ttsKey(plain, voice);
        if (intoMemory) {
          await loadClipUrl(key);
          await loadTimingsCached(key);
        } else {
          await storeClip(key);
        }
      } catch { /* ignore */ }
      tick();
    });
  };
  // The request to generate goes out as soon as every clip has been looked up, while the clips found still warm
  // their timings.
  await Promise.all([timingsWarmed, fetchGenerated()]);
};

// Resolve each clip as a tap would. A clip found warms its timings behind the lookups, in one of WARM_CONCURRENCY
// lanes that each fetch one at a time, so slow timings hold up neither the next clip nor the request to generate
// the missing ones; its sentence counts as done once they settle. Returns the sentences no voice has a clip for,
// and the timings warms still under way.
const warmIntoMemory = async (
  plains: string[],
  style: TtsStyle,
  tick: () => void,
  signal?: AbortSignal,
): Promise<{ missing: string[]; timingsWarmed: Promise<void> }> => {
  const missing: string[] = [];
  const lanes: Array<Promise<void>> = [];
  let found = 0;
  const warmTimings = async (key: string): Promise<void> => {
    if (!signal?.aborted) await loadTimingsCached(key).catch(() => null);
    tick();
  };
  await eachLimited(plains, WARM_CONCURRENCY, signal, async (plain) => {
    try {
      const clip = await resolveCachedClip(plain, style);
      if (!clip) { missing.push(plain); return; } // absent everywhere → generate
      const lane = found++ % WARM_CONCURRENCY;
      lanes[lane] = (lanes[lane] ?? Promise.resolve()).then(() => warmTimings(clip.key));
    } catch { tick(); }
  });
  return { missing, timingsWarmed: Promise.all(lanes).then(() => undefined) };
};

// Check which clips and timings the device holds, all in one go, and download the rest into IndexedDB, walking
// each sentence's voices in the order playback does. Returns the sentences no voice has a clip for.
const warmIntoStorage = async (plains: string[], style: TtsStyle, tick: () => void, signal?: AbortSignal): Promise<string[]> => {
  const tokens = STYLE_VOICES[style].play;
  // A key that can't be computed fails the clip, as a tap would; it still counts as done.
  const keysOf = await Promise.all(plains.map(plain => Promise.all(tokens.map(token => ttsKey(plain, token))).catch(() => null)));
  const allKeys = keysOf.flatMap(keys => keys ?? []);
  const [storedAudio, storedTimings] = await Promise.all([getStoredAudioKeys(allKeys), getStoredTimingKeys(allKeys)]);
  const hasClip = (key: string) => storedAudio.has(key) || hasClipInMemory(key);
  const hasTimings = (key: string) => storedTimings.has(key) || hasTimingsInMemory(key);

  const used: string[] = [];
  const pending: Array<{ plain: string; keys: string[] }> = [];
  plains.forEach((plain, index) => {
    const keys = keysOf[index];
    if (!keys) tick();
    else if (hasClip(keys[0]) && hasTimings(keys[0])) { used.push(keys[0]); tick(); }
    else pending.push({ plain, keys });
  });

  const missing: string[] = [];
  await eachLimited(pending, WARM_CONCURRENCY, signal, async ({ plain, keys }) => {
    try {
      for (const key of keys) {
        if (hasClip(key)) {
          used.push(key);
          if (!hasTimings(key)) await storeTimings(key);
          tick();
          return;
        }
        if (await storeClip(key)) { tick(); return; }
      }
      missing.push(plain); // absent everywhere → generate
    } catch { tick(); }
  });
  // Reading each clip used to mark it as recently used; one transaction does that for the clips found here.
  void markAudioUsed(used);
  return missing;
};

/**
 * Prefetch cached clips for the given texts into the device-local cache so a later tap is instant
 * (and plays through the iOS-unlocked <audio> element, avoiding the gesture-after-await problem).
 * Fetch-only — never triggers generation.
 */
export const prefetchTTS = (texts: string[]): void => {
  warmClips(texts, { intoMemory: true }).catch(() => { /* best-effort */ });
};

/**
 * Like prefetchTTS, but GENERATES any clip that isn't cached yet (then pulls it into the device cache),
 * so a later tap plays the API voice instantly instead of hitting a cache-miss fallback. Use this when
 * fresh AI results arrive (search / refresh) to prepare the audio up front.
 */
export const ensureTTS = async (texts: string[]): Promise<void> => {
  try {
    await warmClips(texts, { generate: true, intoMemory: true });
  } catch {
    /* best-effort — speakNatural still falls back at play time */
  }
};

/**
 * Like ensureTTS, but reports progress (done/total over the de-duplicated set) so a UI can show a
 * "preloading N/M" indicator. A handful of upcoming sentences warm into memory, as ensureTTS does; a whole
 * review session passes `intoMemory: false`, so its clips go to IndexedDB only, and a signal to stop it.
 * Best-effort per item: a failure still ticks progress and never rejects the whole batch.
 */
export const preloadAudio = (
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  options: { intoMemory?: boolean; signal?: AbortSignal } = {},
): Promise<void> => warmClips(texts, { generate: true, intoMemory: options.intoMemory ?? true, onProgress, signal: options.signal });
