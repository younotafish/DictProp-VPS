// Batch warm-ups: fetching the clips (and word timings) of many sentences ahead of a tap, so a later play is
// instant and an unstable network can't interrupt a session. One bounded, abortable routine serves the three
// public entry points below, on the shared worker pool (server/src/shared/pool.ts).
import { runPool } from '../../server/src/shared/pool';
import { requestTTSGeneration, ttsKey } from '../api/tts';
import { audioCacheReady, getStoredAudioKeys, getStoredTimingKeys, markAudioUsed, putAudioBlob, putTimings } from '../audioCache';
import { stripSentenceMarkers } from '../sentenceMarkers';
import { getTtsStyle, type TtsStyle } from '../ttsSettings';
import {
  fetchClipShared, fetchTimingsShared, hasClipInMemory, hasTimingsInMemory, loadClipUrl, loadTimingsCached, resolveCachedClip,
} from './clipStore';
import { STYLE_VOICES } from './voices';

/** Clips a warm-up fetches at once, like the session preload's pictures: enough to keep the line busy without
 *  queueing hundreds of requests ahead of the clip the learner taps next. A warm-up into memory also fetches the
 *  timings of the clips it found, as many at once, beside them. */
export const WARM_CONCURRENCY = 4;

/** A sentence to warm: its text, in the speech style now, or in the style given (the voice it will be read in). */
export type WarmEntry = string | { text: string; style?: TtsStyle };

export interface WarmOptions {
  /** Ask the server to generate the clips it doesn't have (one batch), then fetch them. */
  generate?: boolean;
  /** Open each clip as a ready-to-play object URL, for a handful of sentences the learner is about to reach. A
   *  whole session goes to IndexedDB only, unless IndexedDB is unavailable. */
  intoMemory?: boolean;
  /** Progress over the de-duplicated sentences; one that fails still counts as done. */
  onProgress?: (done: number, total: number) => void;
  /** Once aborted, no new clip is fetched or generated, and a session's downloads under way stop. */
  signal?: AbortSignal;
}

/** One sentence in one voice. */
interface Clip {
  plain: string;
  style: TtsStyle;
}

// A clip, then its timings, from the server straight into IndexedDB: no object URL, so nothing to evict. A download
// playback started is joined rather than repeated, and timings playback already holds aren't fetched again (it
// stores what it fetches too). Only a 404 says the server has no such clip ('missing'); anything else that brings no
// clip (an error, a timeout, a stop) is 'failed', which the next warm-up retries rather than having it generated.
const storeTimings = async (key: string, signal?: AbortSignal): Promise<void> => {
  if (hasTimingsInMemory(key)) return;
  const lookup = await fetchTimingsShared(key, signal);
  if (lookup.kind === 'hit' && lookup.value.length) await putTimings(key, lookup.value);
};
const storeClip = async (key: string, signal?: AbortSignal): Promise<'stored' | 'missing' | 'failed'> => {
  const lookup = await fetchClipShared(key, signal);
  if (lookup.kind !== 'hit') return lookup.kind;
  await putAudioBlob(key, lookup.value);
  await storeTimings(key, signal);
  return 'stored';
};

/**
 * Warm the clips and word timings of `entries`, each in its own voice (a plain text in the speech style now). Each
 * sentence counts once per voice. Small warm-ups resolve every clip as a tap would (memory → IndexedDB → server) and
 * keep it open in memory; a whole session checks IndexedDB for all of them at once and downloads only what's missing,
 * and has generated only the clips the server answered it doesn't have, in every voice the style plays.
 */
export const warmClips = async (entries: readonly WarmEntry[], options: WarmOptions = {}): Promise<void> => {
  const { generate = false, onProgress, signal } = options;
  const nowStyle = getTtsStyle();
  const seen = new Set<string>();
  const clips: Clip[] = [];
  for (const entry of entries) {
    const text = typeof entry === 'string' ? entry : entry.text;
    const style = (typeof entry === 'string' ? undefined : entry.style) ?? nowStyle;
    const plain = stripSentenceMarkers(text || '').trim();
    const id = `${style}\n${plain}`;
    if (!plain || seen.has(id)) continue;
    seen.add(id);
    clips.push({ plain, style });
  }
  const total = clips.length;
  onProgress?.(0, total);
  if (!total) return;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  const intoMemory = options.intoMemory || !(await audioCacheReady());
  const { missing, timingsWarmed } = intoMemory
    ? await warmIntoMemory(clips, tick, signal)
    : { missing: await warmIntoStorage(clips, tick, signal), timingsWarmed: Promise.resolve() };

  // Generate the missing clips server-side (one batch, each in its style's voice), then fetch them.
  const fetchGenerated = async (): Promise<void> => {
    if (!generate || !missing.length || signal?.aborted) return;
    try { await requestTTSGeneration(missing.map(({ plain, style }) => ({ text: plain, voice: STYLE_VOICES[style].generate }))); } catch { /* best-effort */ }
    await runPool(missing, WARM_CONCURRENCY, async ({ plain, style }) => {
      try {
        const key = await ttsKey(plain, STYLE_VOICES[style].generate);
        if (intoMemory) {
          await loadClipUrl(key);
          await loadTimingsCached(key);
        } else {
          await storeClip(key, signal);
        }
      } catch { /* ignore */ }
      tick();
    }, signal);
  };
  // The request to generate goes out as soon as every clip has been looked up, while the clips found still warm
  // their timings.
  await Promise.all([timingsWarmed, fetchGenerated()]);
};

// Resolve each clip as a tap would. A clip found warms its timings behind the lookups, in one of WARM_CONCURRENCY
// lanes that each fetch one at a time, so slow timings hold up neither the next clip nor the request to generate
// the missing ones; its sentence counts as done once they settle. Returns the clips no voice of their style has,
// and the timings warms still under way.
const warmIntoMemory = async (
  clips: Clip[],
  tick: () => void,
  signal?: AbortSignal,
): Promise<{ missing: Clip[]; timingsWarmed: Promise<void> }> => {
  const missing: Clip[] = [];
  const lanes: Array<Promise<void>> = [];
  let found = 0;
  const warmTimings = async (key: string): Promise<void> => {
    if (!signal?.aborted) await loadTimingsCached(key).catch(() => null);
    tick();
  };
  await runPool(clips, WARM_CONCURRENCY, async (clip) => {
    try {
      const cached = await resolveCachedClip(clip.plain, clip.style);
      if (!cached) { missing.push(clip); return; } // absent everywhere → generate
      const lane = found++ % WARM_CONCURRENCY;
      lanes[lane] = (lanes[lane] ?? Promise.resolve()).then(() => warmTimings(cached.key));
    } catch { tick(); }
  }, signal);
  return { missing, timingsWarmed: Promise.all(lanes).then(() => undefined) };
};

// Check which clips and timings the device holds, all in one go, and download the rest into IndexedDB, walking
// each clip's voices in the order playback does. Returns the clips every voice of their style answered missing.
const warmIntoStorage = async (clips: Clip[], tick: () => void, signal?: AbortSignal): Promise<Clip[]> => {
  // A key that can't be computed fails the clip, as a tap would; it still counts as done.
  const keysOf = await Promise.all(clips.map(({ plain, style }) =>
    Promise.all(STYLE_VOICES[style].play.map(token => ttsKey(plain, token))).catch(() => null)));
  const allKeys = keysOf.flatMap(keys => keys ?? []);
  const [storedAudio, storedTimings] = await Promise.all([getStoredAudioKeys(allKeys), getStoredTimingKeys(allKeys)]);
  const hasClip = (key: string) => storedAudio.has(key) || hasClipInMemory(key);
  const hasTimings = (key: string) => storedTimings.has(key) || hasTimingsInMemory(key);

  const used: string[] = [];
  const pending: Array<{ clip: Clip; keys: string[] }> = [];
  clips.forEach((clip, index) => {
    const keys = keysOf[index];
    if (!keys) tick();
    else if (hasClip(keys[0]) && hasTimings(keys[0])) { used.push(keys[0]); tick(); }
    else pending.push({ clip, keys });
  });

  const missing: Clip[] = [];
  await runPool(pending, WARM_CONCURRENCY, async ({ clip, keys }) => {
    try {
      let everyVoiceMissing = true;
      for (const key of keys) {
        if (hasClip(key)) {
          used.push(key);
          if (!hasTimings(key)) await storeTimings(key, signal);
          tick();
          return;
        }
        const stored = await storeClip(key, signal);
        if (stored === 'stored') { tick(); return; }
        if (stored === 'failed') everyVoiceMissing = false;
      }
      if (everyVoiceMissing) missing.push(clip); // the server has it in no voice → generate
      else tick(); // a download failed: the next warm-up tries again
    } catch { tick(); }
  }, signal);
  // Reading each clip used to mark it as recently used; one transaction does that for the clips found here.
  void markAudioUsed(used);
  return missing;
};

/**
 * Prefetch cached clips for the given texts into the device-local cache so a later tap is instant
 * (and plays through the iOS-unlocked <audio> element, avoiding the gesture-after-await problem).
 * Fetch-only — never triggers generation.
 */
export const prefetchTTS = (texts: readonly WarmEntry[]): void => {
  warmClips(texts, { intoMemory: true }).catch(() => { /* best-effort */ });
};

/**
 * Like prefetchTTS, but GENERATES any clip that isn't cached yet (then pulls it into the device cache),
 * so a later tap plays the API voice instantly instead of hitting a cache-miss fallback. Use this when
 * fresh AI results arrive (search / refresh) to prepare the audio up front.
 */
export const ensureTTS = async (texts: readonly WarmEntry[]): Promise<void> => {
  try {
    await warmClips(texts, { generate: true, intoMemory: true });
  } catch {
    /* best-effort — speakNatural still falls back at play time */
  }
};

/**
 * Like ensureTTS, but reports progress (done/total over the de-duplicated set) so a UI can show a
 * "preloading N/M" indicator. A handful of upcoming sentences warm into memory, as ensureTTS does; an auto-play
 * session's plan passes `intoMemory: false`, so its clips go to IndexedDB only, each entry in its own voice, and a
 * signal that stops it. Best-effort per item: a failure still ticks progress and never rejects the whole batch.
 */
export const preloadAudio = (
  entries: readonly WarmEntry[],
  onProgress?: (done: number, total: number) => void,
  options: { intoMemory?: boolean; signal?: AbortSignal } = {},
): Promise<void> => warmClips(entries, { generate: true, intoMemory: options.intoMemory ?? true, onProgress, signal: options.signal });
