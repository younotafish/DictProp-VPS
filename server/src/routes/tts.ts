// The speech cache's HTTP routes: serve cached clips and their word timings, generate missing clips on request,
// and start or report the background backfill. The cache itself lives in server/src/tts/.
import { Hono } from 'hono';
import { readFile } from 'fs/promises';
import type { AlignmentPriority } from '../local-whisper.js';
import { GENERATE_MAX_ITEMS } from '../shared/ai-limits.js';
import { getBackfillStatus, getDetachedBackfillStatus, runBackfill } from '../tts/backfill.js';
import {
  CASUAL_STYLE,
  fileExists,
  isComplete,
  MIMO_VOICE,
  OFFLINE_CACHE_VOICES,
  pathForKey,
  sniffContentType,
  timingsPathForKey,
  ttsKey,
} from '../tts/cache.js';
import { ensureAudio, ensureTimings } from '../tts/clips.js';

export const ttsRoutes = new Hono();

// POST /api/tts/backfill — start the background backfill (no-op if already running); returns status.
// GET  /api/tts/backfill — current progress. Registered BEFORE /tts/:name so "backfill" isn't read as a key.
ttsRoutes.post('/tts/backfill', async (c) => {
  const detached = await getDetachedBackfillStatus();
  if (detached) return c.json(detached);
  runBackfill().catch((e) => console.warn('[tts] backfill error:', e?.message));
  return c.json(getBackfillStatus());
});
ttsRoutes.get('/tts/backfill', async (c) => c.json((await getDetachedBackfillStatus()) ?? getBackfillStatus()));

// GET /api/tts/:name  (name = "<64-hex-key>.mp3") — serve the cached clip or 404. Never generates.
ttsRoutes.get('/tts/:name', async (c) => {
  const key = c.req.param('name').replace(/\.(mp3|wav)$/i, '');
  if (!/^[0-9a-f]{64}$/.test(key)) return c.json({ error: 'bad key' }, 400);
  let buf: Buffer;
  try {
    buf = await readFile(pathForKey(key));
  } catch {
    return c.json({ error: 'not cached' }, 404);
  }
  return c.body(buf, 200, {
    'Content-Type': sniffContentType(buf),
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

// GET /api/tts/:name/timings  (name = "<64-hex-key>") — serve the clip's word timings or 404.
ttsRoutes.get('/tts/:name/timings', async (c) => {
  const key = c.req.param('name').replace(/\.(mp3|wav|json)$/i, '');
  if (!/^[0-9a-f]{64}$/.test(key)) return c.json({ error: 'bad key' }, 400);
  let buf: Buffer;
  try {
    buf = await readFile(timingsPathForKey(key));
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
// Covers every study sentence: essay-catalog sentences run to ~600 characters and examples to 1000.
export const GENERATE_MAX_TEXT_CHARS = 1000;
const GENERATE_CONCURRENCY = 3;
// Only the tracks the client plays. Any other name would mint a new MiMo cache entry per request.
const GENERATE_VOICES = new Set([MIMO_VOICE, CASUAL_STYLE]);

ttsRoutes.post('/tts/generate', async (c) => {
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
    if (OFFLINE_CACHE_VOICES.has(voice)) { skipped++; return; }
    if (!GENERATE_VOICES.has(voice)) { failed++; return; }
    try {
      const key = ttsKey(text, voice);
      // Skip when both the clip and its local word timings are complete.
      if (await isComplete(key)) { skipped++; return; }
      const fresh = await ensureAudio(text, voice);
      void ensureTimings(key, priority, fresh)
        .catch((e: any) => console.warn('[tts] word timings failed:', e?.message));
      generated++;
    } catch (e: any) {
      console.warn('[tts] generate failed:', e?.message);
      failed++;
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) await generateOne(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(GENERATE_CONCURRENCY, items.length) }, () => worker()));
  return c.json({ generated, skipped, failed });
});

// POST /api/tts/manifest  { keys: [...], audioOnly?: bool } -> { have: [...] }  (which keys are cached).
// audioOnly=true lets callers inventory clips independently. The default requires audio + timings,
// so ordinary sweeps also repair legacy audio-only cache entries.
ttsRoutes.post('/tts/manifest', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const keys: string[] = Array.isArray(body?.keys) ? body.keys : [];
  const audioOnly = body?.audioOnly === true;
  const have: string[] = [];
  for (const k of keys) {
    if (!/^[0-9a-f]{64}$/.test(k)) continue;
    if (!(await fileExists(pathForKey(k)))) continue;
    if (audioOnly || (await fileExists(timingsPathForKey(k)))) have.push(k);
  }
  return c.json({ have });
});
