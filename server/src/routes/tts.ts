// The speech cache's HTTP routes: serve cached clips and their word timings, generate missing clips on request,
// and start or report the background backfill. The cache itself lives in server/src/tts/.
import { Hono } from 'hono';
import { readFile } from 'fs/promises';
import type { AlignmentPriority } from '../local-whisper.js';
import { GENERATE_MAX_ITEMS } from '../shared/ai-limits.js';
import { createBackfill, getDetachedBackfillStatus, type BackfillTexts } from '../tts/backfill.js';
import {
  audioPath,
  CASUAL_STYLE,
  isCacheKey,
  isComplete,
  isOfflineVoice,
  MIMO_VOICE,
  sniffContentType,
  timingsPath,
  ttsKey,
} from '../tts/cache.js';
import { createClipStore, defaultClipDependencies, type ClipDependencies } from '../tts/clips.js';
import { runPool } from '../tts/pool.js';

// Covers every study sentence: essay-catalog sentences run to ~600 characters and examples to 1000.
export const GENERATE_MAX_TEXT_CHARS = 1000;
const GENERATE_CONCURRENCY = 3;
// Only the tracks the client plays. Any other name would mint a new MiMo cache entry per request.
const GENERATE_VOICES = new Set([MIMO_VOICE, CASUAL_STYLE]);

export interface TtsRouteDependencies extends Partial<ClipDependencies> {
  reduceBatch?: (sentences: string[]) => Promise<Array<string | null>>;
  backfillTexts?: () => BackfillTexts;
  backfillRetryDelayMs?: number;
}

export function createTtsRoutes(deps: TtsRouteDependencies = {}) {
  const { reduceBatch, backfillTexts, backfillRetryDelayMs, ...clipOverrides } = deps;
  // One clip store for the routes and this process's backfill, so they share its in-flight dedupe.
  const clips = createClipStore({ ...defaultClipDependencies, ...clipOverrides });
  const backfill = createBackfill({ clips, reduceBatch, sentenceTexts: backfillTexts, retryDelayMs: backfillRetryDelayMs });
  const routes = new Hono();

  // POST /api/tts/backfill — start the background backfill unless one is going, here or in the detached worker;
  // returns its status. GET /api/tts/backfill — current progress. Registered BEFORE /tts/:name so "backfill" isn't
  // read as a key.
  routes.post('/tts/backfill', async (c) => {
    const detached = await getDetachedBackfillStatus();
    if (detached) return c.json(detached);
    await backfill.start();
    return c.json(backfill.status());
  });
  routes.get('/tts/backfill', async (c) => c.json((await getDetachedBackfillStatus()) ?? backfill.status()));

  // GET /api/tts/:name  (name = "<64-hex-key>.mp3") — serve the cached clip or 404. Never generates.
  routes.get('/tts/:name', async (c) => {
    const key = c.req.param('name').replace(/\.(mp3|wav)$/i, '');
    if (!isCacheKey(key)) return c.json({ error: 'bad key' }, 400);
    let buf: Buffer;
    try {
      buf = await readFile(audioPath(key));
    } catch {
      return c.json({ error: 'not cached' }, 404);
    }
    return c.body(buf, 200, {
      'Content-Type': sniffContentType(buf),
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  // GET /api/tts/:name/timings  (name = "<64-hex-key>") — serve the clip's word timings or 404.
  routes.get('/tts/:name/timings', async (c) => {
    const key = c.req.param('name').replace(/\.(mp3|wav|json)$/i, '');
    if (!isCacheKey(key)) return c.json({ error: 'bad key' }, 400);
    let buf: Buffer;
    try {
      buf = await readFile(timingsPath(key));
    } catch {
      return c.json({ error: 'not cached' }, 404);
    }
    return c.body(buf, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });

  // POST /api/tts/generate  { items: [{ text, voice? }] } -> { generated, skipped, failed }.
  // Used by the live cache-miss trigger (fire-and-forget, usually 1 item) and the bulk sweep, which the
  // client splits into requests of at most GENERATE_MAX_ITEMS. Responds once each clip's AUDIO is stored —
  // it is playable then — and aligns word timings afterwards; a lone live clip's alignment jumps ahead of
  // backfill work. A client that disconnects stops further items from starting.
  routes.post('/tts/generate', async (c) => {
    // Read before any await: the node adapter only aborts a signal that was accessed.
    const signal = c.req.raw.signal;
    const body = await c.req.json().catch(() => ({}));
    const items: Array<{ text?: unknown; voice?: unknown }> = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return c.json({ error: 'no items' }, 400);
    if (items.length > GENERATE_MAX_ITEMS) {
      return c.json({ error: `at most ${GENERATE_MAX_ITEMS} items per request` }, 400);
    }
    const priority: AlignmentPriority = items.length === 1 ? 'interactive' : 'background';
    let generated = 0, skipped = 0, failed = 0;
    const generateOne = async (item: { text?: unknown; voice?: unknown }) => {
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      const voice = typeof item?.voice === 'string' && item.voice ? item.voice : MIMO_VOICE;
      if (!text || text.length > GENERATE_MAX_TEXT_CHARS) { failed++; return; }
      // Versioned Qwen clips are generated, aligned, and validated on Apple Silicon, then imported.
      // Never silently put MiMo bytes behind an immutable Qwen cache key.
      if (isOfflineVoice(voice)) { skipped++; return; }
      if (!GENERATE_VOICES.has(voice)) { failed++; return; }
      try {
        const key = ttsKey(text, voice);
        // Skip when both the clip and its local word timings are complete.
        if (await isComplete(key)) { skipped++; return; }
        const fresh = await clips.ensureAudio(text, voice);
        void clips.ensureTimings(key, priority, fresh)
          .catch((e: unknown) => console.warn('[tts] word timings failed:', (e as Error | undefined)?.message));
        generated++;
      } catch (e) {
        console.warn('[tts] generate failed:', (e as Error | undefined)?.message);
        failed++;
      }
    };
    await runPool(items, GENERATE_CONCURRENCY, generateOne, signal);
    return c.json({ generated, skipped, failed });
  });

  return routes;
}

export const ttsRoutes = createTtsRoutes();
