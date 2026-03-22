import { Hono } from 'hono';
import { getAllItems, getItemsSince, upsertItem, upsertMany, softDeleteItem, getItemById } from '../db.js';

export const itemsRoutes = new Hono();

// GET /api/items — return all items, or delta since ?since=timestamp
// ?images=true to include base64 images (default: stripped for fast load)
itemsRoutes.get('/items', (c) => {
  const includeImages = c.req.query('images') === 'true';
  const since = c.req.query('since');
  if (since) {
    const ts = parseInt(since, 10);
    if (isNaN(ts)) return c.json({ error: 'Invalid since parameter' }, 400);
    return c.json(getItemsSince(ts, !includeImages));
  }
  return c.json(getAllItems(!includeImages));
});

// GET /api/items/:id — return a single item
itemsRoutes.get('/items/:id', (c) => {
  const item = getItemById(c.req.param('id'));
  if (!item) return c.json({ error: 'Not found' }, 404);
  return c.json(item);
});

// PUT /api/items/:id — upsert a single item
itemsRoutes.put('/items/:id', async (c) => {
  const body = await c.req.json();
  if (!body.data || !body.data.id) {
    return c.json({ error: 'Item missing data.id' }, 400);
  }
  // Ensure URL param matches body
  body.data.id = c.req.param('id');
  upsertItem(body);
  return c.json({ ok: true });
});

// PUT /api/items — batch upsert (array of items)
itemsRoutes.put('/items', async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body)) {
    return c.json({ error: 'Expected array of items' }, 400);
  }
  upsertMany(body);
  return c.json({ ok: true, count: body.length });
});

// DELETE /api/items/:id — soft delete
itemsRoutes.delete('/items/:id', (c) => {
  softDeleteItem(c.req.param('id'));
  return c.json({ ok: true });
});

// POST /api/import — bulk import (for Firebase migration)
itemsRoutes.post('/import', async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body)) {
    return c.json({ error: 'Expected array of StoredItems' }, 400);
  }
  const valid = body.filter((i: any) => i && i.data && i.data.id && i.type);
  if (valid.length === 0) {
    return c.json({ error: 'No valid items found' }, 400);
  }
  upsertMany(valid);
  return c.json({ ok: true, imported: valid.length, skipped: body.length - valid.length });
});
