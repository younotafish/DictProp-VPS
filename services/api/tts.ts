import { GENERATE_MAX_ITEMS } from '../../server/src/shared/ai-limits';
import { fetchWithin, jsonRequest, requestJson } from '../http';
import { sha256Hex } from '../sha256';

// Server-side speech: cached clips and their word timings by key, generation, and the background backfill. The
// voice tokens each speech style uses are in services/audio/voices.ts.

/** One word's playback timing within a cached clip (from the server's whisper word-alignment pass). */
export interface WordTiming { start: number; end: number; text: string }

/**
 * Cache key for a clip — sha256(voice + "\n" + text.trim()), hex.
 * MUST match the server's ttsKey (server/src/tts/cache.ts); server/test/tts-cache.test.ts and
 * test/client/tts-api.test.ts pin the same digests, so a change on either side fails a test.
 */
export const ttsKey = async (text: string, voice: string): Promise<string> =>
  sha256Hex(new TextEncoder().encode(`${voice}\n${text.trim()}`));

// A plain fetch() has NO timeout: a stalled connection (a wedged mobile keep-alive socket, or the
// 1-vCPU VPS briefly busy) leaves the await hanging for the browser's multi-minute default — the
// "audio takes forever to load even on good 5G" symptom. Bound every TTS fetch so a stall aborts and
// the caller can fall back (system/Kokoro voice) instead of hanging. The timeout spans headers AND the
// body read (fetchWithin), so a mid-body stall is caught too.
const TTS_AUDIO_TIMEOUT_MS = 8000;    // audio is what we play — be patient, but never infinite
const TTS_TIMINGS_TIMEOUT_MS = 6000;  // timings are non-essential (lead-in trim / seek) — bg-warmed

/**
 * What a request to the speech cache found: the value, `missing` when the server has none (only a 404 says so), or
 * `failed` for anything else (another status, a body that isn't what was asked for, a timeout, an abort or no
 * connection), which a later attempt may retry. A clip is worth generating only when it is missing.
 */
export type CachedLookup<T> = { kind: 'hit'; value: T } | { kind: 'missing' } | { kind: 'failed' };

export interface CachedLookupOptions {
  /** Aborting it ends the request, as failed. */
  signal?: AbortSignal;
  /** How long the headers and the body may take; past it, the request fails. */
  timeoutMs?: number;
}

const MISSING = { kind: 'missing' } as const;
const FAILED = { kind: 'failed' } as const;

/** GET `url` from the speech cache; `read` returns the body's value, or undefined when it isn't one. Never rejects. */
const lookUpCached = async <T>(
  url: string,
  { signal, timeoutMs }: CachedLookupOptions,
  defaultTimeoutMs: number,
  read: (response: Response) => Promise<T | undefined>,
): Promise<CachedLookup<T>> => {
  const init = signal ? { signal } : undefined;
  try {
    return await fetchWithin(url, init, timeoutMs ?? defaultTimeoutMs, async (response): Promise<CachedLookup<T>> => {
      if (response.status === 404) return MISSING;
      if (!response.ok) return FAILED;
      const value = await read(response);
      return value === undefined ? FAILED : { kind: 'hit', value };
    });
  } catch {
    return FAILED;
  }
};

/** Clip `key`'s audio from the speech cache. */
export const fetchCachedClipByKey = (key: string, options: CachedLookupOptions = {}): Promise<CachedLookup<Blob>> =>
  lookUpCached(`/api/tts/${key}.mp3`, options, TTS_AUDIO_TIMEOUT_MS, response => response.blob());

/** Clip `key`'s per-word timings from the speech cache. */
export const fetchCachedTimingsByKey = (key: string, options: CachedLookupOptions = {}): Promise<CachedLookup<WordTiming[]>> =>
  lookUpCached(`/api/tts/${key}/timings`, options, TTS_TIMINGS_TIMEOUT_MS, async (response) => {
    const data: unknown = await response.json();
    return Array.isArray(data) ? data as WordTiming[] : undefined;
  });

/** The cached clip of `text` (speakable, without markers) in voice token `voice`: the clip at ttsKey(text, voice). */
export const fetchCachedClip = async (
  text: string,
  voice: string,
  options: CachedLookupOptions = {},
): Promise<CachedLookup<Blob>> => {
  const key = await ttsKey(text, voice).catch(() => null);
  return key ? fetchCachedClipByKey(key, options) : FAILED;
};

/** The per-word timings of the cached clip of `text` in voice token `voice` (see fetchCachedClip). */
export const fetchCachedTimings = async (
  text: string,
  voice: string,
  options: CachedLookupOptions = {},
): Promise<CachedLookup<WordTiming[]>> => {
  const key = await ttsKey(text, voice).catch(() => null);
  return key ? fetchCachedTimingsByKey(key, options) : FAILED;
};

const valueOrNull = <T>(lookup: CachedLookup<T>): T | null => (lookup.kind === 'hit' ? lookup.value : null);

/** Fetch a cached clip by key. Returns the audio Blob, or null on miss (404) / timeout / error. */
export const fetchCachedTTS = async (key: string, timeoutMs = TTS_AUDIO_TIMEOUT_MS): Promise<Blob | null> =>
  valueOrNull(await fetchCachedClipByKey(key, { timeoutMs }));

/** Fetch a clip's per-word timings by key. Returns the WordTiming[] or null on miss / timeout / error. */
export const fetchCachedTTSTimings = async (key: string, timeoutMs = TTS_TIMINGS_TIMEOUT_MS): Promise<WordTiming[] | null> =>
  valueOrNull(await fetchCachedTimingsByKey(key, { timeoutMs }));

// The server takes at most GENERATE_MAX_ITEMS clips per request and answers once their audio is stored (three
// at a time, a few seconds each), so a full request needs well over the default 30 s.
const TTS_GENERATE_TIMEOUT_MS = 180_000;

/** Ask the server to generate + cache clips (used by the live cache-miss trigger and the bulk sweep). */
export const requestTTSGeneration = async (
  items: Array<{ text: string; voice?: string }>
): Promise<{ generated: number; skipped: number; failed: number }> => {
  const total = { generated: 0, skipped: 0, failed: 0 };
  for (let start = 0; start < items.length; start += GENERATE_MAX_ITEMS) {
    const result = await requestJson<{ generated?: number; skipped?: number; failed?: number }>(
      '/api/tts/generate',
      jsonRequest('POST', { items: items.slice(start, start + GENERATE_MAX_ITEMS) }),
      'Generate TTS',
      TTS_GENERATE_TIMEOUT_MS,
    );
    total.generated += Number(result.generated) || 0;
    total.skipped += Number(result.skipped) || 0;
    total.failed += Number(result.failed) || 0;
  }
  return total;
};

export interface TtsBackfillStatus { running: boolean; total: number; done: number; generated: number; failed: number }

/** Start the server-side background backfill (audio + word timings for every sentence). Idempotent. */
export const startTtsBackfill = async (): Promise<TtsBackfillStatus> => {
  return requestJson<TtsBackfillStatus>(
    '/api/tts/backfill',
    { method: 'POST' },
    'Start TTS backfill',
  );
};

/** Poll the server-side backfill progress. */
export const getTtsBackfillStatus = async (): Promise<TtsBackfillStatus> => {
  return requestJson<TtsBackfillStatus>(
    '/api/tts/backfill',
    undefined,
    'Load TTS backfill status',
  );
};
