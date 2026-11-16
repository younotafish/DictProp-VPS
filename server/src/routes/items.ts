import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import { getItemById, getItemsAfterRevision, upsertMany, type ItemRead } from '../db.js';
import type { AppEnv } from '../middleware/auth.js';
import { readJsonArray } from '../middleware/json-body.js';
import { checkStoredItemBatch, MAX_ID_LENGTH } from '../validation.js';

export const itemsRoutes = new Hono<AppEnv>();

function streamAllItems(c: Context<AppEnv>, userId: string) {
  c.header('Content-Type', 'application/json; charset=UTF-8');
  return stream(c, async output => {
    let cursor = { revision: 0, id: '' };
    let first = true;
    let pageCount = 0;
    await output.write('[');
    for (;;) {
      const page = getItemsAfterRevision(cursor, 200, userId);
      if (page.items.length > 0) {
        const body = JSON.stringify(page.items).slice(1, -1);
        if (body) {
          await output.write(`${first ? '' : ','}${body}`);
          first = false;
        }
      }
      if (!page.hasMore) break;
      // A client that went away gets no more pages.
      if (output.aborted) return;
      if (page.cursor.revision === cursor.revision && page.cursor.id === cursor.id) {
        throw new Error('Item stream cursor did not advance');
      }
      cursor = page.cursor;
      if (++pageCount > 100_000) throw new Error('Item stream exceeded its page limit');
      await output.sleep(0);
    }
    await output.write(']');
  });
}

// GET /api/items — return stripped items or revision deltas. Images are always fetched separately.
itemsRoutes.get('/items', (c) => {
  const userId = c.get('user').id;
  if (c.req.query('images') === 'true') {
    return c.json({ error: 'Bulk image responses are disabled; use the image endpoints' }, 400);
  }
  const afterRevision = c.req.query('afterRevision');
  if (afterRevision !== undefined) {
    const revision = Number(afterRevision);
    const afterId = c.req.query('afterId') || '';
    const limit = Number(c.req.query('limit') || 200);
    if (!Number.isSafeInteger(revision) || revision < 0 || afterId.length > MAX_ID_LENGTH ||
        !Number.isSafeInteger(limit) || limit < 1) {
      return c.json({ error: 'Invalid revision cursor' }, 400);
    }
    return c.json(getItemsAfterRevision({ revision, id: afterId }, limit, userId));
  }
  // Keep the legacy array response contract, but serialize bounded pages into a stream. A large
  // regenerated corpus must not monopolize the single Node event loop during JSON conversion.
  return streamAllItems(c, userId);
});

// GET /api/items/:id — return a single item
itemsRoutes.get('/items/:id', (c) => {
  const userId = c.get('user').id;
  const item = getItemById(c.req.param('id'), userId);
  if (!item) return c.json({ error: 'Not found' }, 404);
  return c.json(item);
});

// PUT /api/items — batch upsert (array of items)
itemsRoutes.put('/items', async (c) => {
  const userId = c.get('user').id;
  const batch = checkStoredItemBatch(await readJsonArray(c), 500);
  if ('error' in batch) return c.json({ error: batch.error }, 400);
  const { enriched, ...result } = upsertMany(batch.items, userId);
  // Return sentences the enrichment pool just analysed immediately instead of waiting for the next
  // 8-second delta pull. Conflicts use this same bounded canonical response path. Fields the server
  // merely kept from its stored copy are left out, since adopting a canonical copy drops an edit made
  // while the push was in flight. The saving client keeps its own data at an unchanged revision, so it
  // lacks those fields until the row next changes.
  const canonicalIds = new Set([...result.conflicts, ...enriched]);
  const canonical = [...canonicalIds]
    .map(id => getItemById(id, userId, false))
    .filter((item): item is ItemRead => !!item);
  return c.json({ ok: true, count: batch.items.length, ...result, canonical });
});
