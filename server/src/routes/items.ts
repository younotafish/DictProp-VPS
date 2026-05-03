import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { getAllItems, getItemsSince, upsertItem, upsertMany, softDeleteItem, getItemById, getItemImage, getItemImagesBatch, getProjects, createProject, renameProject, deleteProject } from '../db.js';
import { proxyFetch } from '../proxy-fetch.js';
import type { AuthVariables } from '../middleware/auth.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_FETCH_TIMEOUT_MS = 30_000;

/** Reject internal/loopback hosts to prevent SSRF via the import endpoint. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local + cloud metadata
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

/** Fetch an image URL and return as base64 data URI, or undefined on failure. */
async function fetchImageAsBase64(url: string): Promise<string | undefined> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (isPrivateHost(parsed.hostname)) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await proxyFetch(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (declaredLength > MAX_IMAGE_BYTES) return undefined;
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) return undefined;
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/png';
    return `data:${mimeType};base64,${base64}`;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap a plain VocabCard object into a full StoredItem. */
function wrapVocabCard(card: any, project?: string): any {
  const id = card.id || randomUUID();
  const now = Date.now();
  return {
    type: 'vocab',
    data: { ...card, id },
    srs: {
      id,
      type: 'vocab',
      nextReview: 0,
      interval: 0,
      memoryStrength: 0,
      lastReviewDate: 0,
      totalReviews: 0,
      correctStreak: 0,
      stability: 0,
    },
    savedAt: now,
    ...(project ? { project } : {}),
  };
}

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

// POST /api/import — bulk import
// Accepts either:
//   1. StoredItem[] (full format with data/type/srs wrappers)
//   2. VocabCard[] (simplified — just word/chinese/definition/etc, auto-wrapped)
// If imageUrl is an HTTP URL, fetches and converts to base64.
// Optional query: ?project=<id> to assign all items to a project.
itemsRoutes.post('/import', async (c) => {
  const userId = c.get('user').id;
  const project = c.req.query('project') || undefined;
  const body = await c.req.json();
  if (!Array.isArray(body)) {
    return c.json({ error: 'Expected array of items' }, 400);
  }

  // Normalize: detect simplified VocabCard format and wrap
  const items: any[] = body.map((item: any) => {
    if (item && item.data && item.type) return item; // already StoredItem
    if (item && item.word) return wrapVocabCard(item, project); // plain VocabCard
    return null;
  }).filter(Boolean);

  // Apply project override to full-format items too
  if (project) {
    for (const item of items) {
      if (!item.project) item.project = project;
    }
  }

  if (items.length === 0) {
    return c.json({ error: 'No valid items found' }, 400);
  }

  // Fetch HTTP image URLs → base64 (concurrently, max 5 at a time)
  let imagesFetched = 0;
  const imageItems = items.filter((i: any) => {
    const url = i.data?.imageUrl;
    return url && typeof url === 'string' && url.startsWith('http');
  });

  // Process in batches of 5
  for (let i = 0; i < imageItems.length; i += 5) {
    const batch = imageItems.slice(i, i + 5);
    await Promise.all(
      batch.map(async (item: any) => {
        const base64 = await fetchImageAsBase64(item.data.imageUrl);
        if (base64) {
          item.data.imageUrl = base64;
          imagesFetched++;
        } else {
          // Clear failed URL so it doesn't break the frontend
          delete item.data.imageUrl;
        }
      })
    );
  }

  // Also handle imageUrl on nested vocabs (for phrase/SearchResult items)
  for (const item of items) {
    if (Array.isArray(item.data?.vocabs)) {
      for (const vocab of item.data.vocabs) {
        if (vocab.imageUrl && typeof vocab.imageUrl === 'string' && vocab.imageUrl.startsWith('http')) {
          const base64 = await fetchImageAsBase64(vocab.imageUrl);
          if (base64) {
            vocab.imageUrl = base64;
            imagesFetched++;
          } else {
            delete vocab.imageUrl;
          }
        }
      }
    }
  }

  upsertMany(items, userId);
  return c.json({
    ok: true,
    imported: items.length,
    skipped: body.length - items.length,
    imagesFetched,
  });
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
  console.log('[projects] POST /projects - start');
  try {
    const userId = c.get('user').id;
    console.log('[projects] userId:', userId);
    const body = await c.req.json();
    console.log('[projects] body:', JSON.stringify(body));
    const name = body?.name;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'Project name is required' }, 400);
    }
    const id = randomUUID();
    console.log('[projects] creating project:', id, name.trim());
    createProject(id, name.trim(), userId);
    console.log('[projects] project created successfully');
    const result = { id, name: name.trim(), createdAt: Date.now() };
    console.log('[projects] returning:', JSON.stringify(result));
    return c.json(result);
  } catch (e: any) {
    console.error('[projects] POST /projects error:', e);
    return c.json({ error: e.message || 'Internal error' }, 500);
  }
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
