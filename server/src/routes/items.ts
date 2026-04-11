import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { getAllItems, getItemsSince, upsertItem, upsertMany, softDeleteItem, getItemById, getItemImage, getItemImagesBatch, getProjects, createProject, renameProject, deleteProject } from '../db.js';
import type { AuthVariables } from '../middleware/auth.js';

export const itemsRoutes = new Hono<{ Variables: AuthVariables }>();

// GET /api/items — return all items, or delta since ?since=timestamp
// ?images=true to include base64 images (default: stripped for fast load)
itemsRoutes.get('/items', (c) => {
  const userId = c.get('user').id;
  const includeImages = c.req.query('images') === 'true';
  const since = c.req.query('since');
  if (since) {
    const ts = parseInt(since, 10);
    if (isNaN(ts)) return c.json({ error: 'Invalid since parameter' }, 400);
    return c.json(getItemsSince(ts, !includeImages, userId));
  }
  return c.json(getAllItems(!includeImages, userId));
});

// GET /api/items/:id/image — return raw binary image with caching headers
itemsRoutes.get('/items/:id/image', (c) => {
  const userId = c.get('user').id;
  const dataUri = getItemImage(c.req.param('id'), userId);
  if (!dataUri) return c.notFound();

  const match = dataUri.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return c.notFound();

  const binary = Buffer.from(match[2], 'base64');
  return new Response(binary, {
    headers: {
      'Content-Type': match[1],
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
});

// POST /api/items/images — batch fetch images for multiple item IDs
itemsRoutes.post('/items/images', async (c) => {
  const userId = c.get('user').id;
  const { ids } = await c.req.json();
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: 'Expected { ids: string[] }' }, 400);
  }
  // Cap at 20 per request to limit response size
  const capped = ids.slice(0, 20);
  const images = getItemImagesBatch(capped, userId);
  return c.json(images);
});

// GET /api/items/:id — return a single item
itemsRoutes.get('/items/:id', (c) => {
  const userId = c.get('user').id;
  const item = getItemById(c.req.param('id'), userId);
  if (!item) return c.json({ error: 'Not found' }, 404);
  return c.json(item);
});

// PUT /api/items/:id — upsert a single item
itemsRoutes.put('/items/:id', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json();
  if (!body.data || !body.data.id) {
    return c.json({ error: 'Item missing data.id' }, 400);
  }
  // Ensure URL param matches body
  body.data.id = c.req.param('id');
  upsertItem(body, userId);
  return c.json({ ok: true });
});

// PUT /api/items — batch upsert (array of items)
itemsRoutes.put('/items', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json();
  if (!Array.isArray(body)) {
    return c.json({ error: 'Expected array of items' }, 400);
  }
  upsertMany(body, userId);
  return c.json({ ok: true, count: body.length });
});

// DELETE /api/items/:id — soft delete
itemsRoutes.delete('/items/:id', (c) => {
  const userId = c.get('user').id;
  softDeleteItem(c.req.param('id'), userId);
  return c.json({ ok: true });
});

// POST /api/import — bulk import (for Firebase migration)
itemsRoutes.post('/import', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json();
  if (!Array.isArray(body)) {
    return c.json({ error: 'Expected array of StoredItems' }, 400);
  }
  const valid = body.filter((i: any) => i && i.data && i.data.id && i.type);
  if (valid.length === 0) {
    return c.json({ error: 'No valid items found' }, 400);
  }
  upsertMany(valid, userId);
  return c.json({ ok: true, imported: valid.length, skipped: body.length - valid.length });
});

// ─── Project routes ───

itemsRoutes.get('/projects', (c) => {
  const userId = c.get('user').id;
  return c.json(getProjects(userId).map(p => ({
    id: p.id,
    name: p.name,
    createdAt: p.created_at,
  })));
});

itemsRoutes.post('/projects', async (c) => {
  const userId = c.get('user').id;
  const { name } = await c.req.json();
  if (!name || typeof name !== 'string' || !name.trim()) {
    return c.json({ error: 'Project name is required' }, 400);
  }
  const id = randomUUID();
  createProject(id, name.trim(), userId);
  return c.json({ id, name: name.trim(), createdAt: Date.now() });
});

itemsRoutes.put('/projects/:id', async (c) => {
  const userId = c.get('user').id;
  const { name } = await c.req.json();
  if (!name || typeof name !== 'string' || !name.trim()) {
    return c.json({ error: 'Project name is required' }, 400);
  }
  renameProject(c.req.param('id'), name.trim(), userId);
  return c.json({ ok: true });
});

itemsRoutes.delete('/projects/:id', (c) => {
  const userId = c.get('user').id;
  deleteProject(c.req.param('id'), userId);
  return c.json({ ok: true });
});
