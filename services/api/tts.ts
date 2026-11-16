import { GENERATE_MAX_ITEMS } from '../../server/src/shared/ai-limits';
import { fetchWithin, jsonRequest, requestJson } from '../http';
import { sha256Hex } from '../sha256';

// Server-side speech: the voices, cached clips and their word timings by key, generation, and the background
// backfill.

// MiMo remains the production default while the offline replacement undergoes a blinded
// connected-speech benchmark. Imported Qwen clips retain their immutable cache keys on the server,
// but the client must not prefer them until a perceptual recipe is approved.
export const TTS_VOICE = 'Mia';
export const TTS_CASUAL_VOICE = 'casual';
export const TTS_LEGACY_VOICE = 'Mia';
export const TTS_LEGACY_CASUAL_VOICE = 'casual';

/** One word's playback timing within a cached clip (from the server's whisper word-alignment pass). */
export interface WordTiming { start: number; end: number; text: string }

/**
 * Cache key for a clip — sha256(voice + "\n" + text.trim()), hex.
 * MUST match the server's ttsKey (server/src/tts/cache.ts).
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

/** Fetch a cached clip by key. Returns the audio Blob, or null on miss (404) / timeout / error. */
export const fetchCachedTTS = async (key: string, timeoutMs = TTS_AUDIO_TIMEOUT_MS): Promise<Blob | null> => {
  try {
    return await fetchWithin(`/api/tts/${key}.mp3`, undefined, timeoutMs, async (res) => (res.ok ? await res.blob() : null));
  } catch {
    return null;
  }
};

/** Fetch a clip's per-word timings by key. Returns the WordTiming[] or null on miss / timeout / error. */
export const fetchCachedTTSTimings = async (key: string, timeoutMs = TTS_TIMINGS_TIMEOUT_MS): Promise<WordTiming[] | null> => {
  try {
    return await fetchWithin(`/api/tts/${key}/timings`, undefined, timeoutMs, async (res) => {
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : null;
    });
  } catch {
    return null;
  }
};

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
