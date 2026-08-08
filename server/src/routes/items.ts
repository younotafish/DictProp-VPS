import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import { randomUUID } from 'crypto';
import { getItemsSince, getItemsAfterRevision, upsertItem, upsertMany, softDeleteItem, getItemById, getItemImage, getItemImagesBatch, getImageManifest, upsertItemImages, addReviewEvent, getReviewEvents, applyReviewEvent, undoReviewEvent, upsertItemImageBinary, getSentenceEnrichmentForText, getSentenceEnrichmentImage } from '../db.js';
import { proxyFetch } from '../proxy-fetch.js';
import type { AuthVariables } from '../middleware/auth.js';
import { detectImageMimeType } from '../image-format.js';
import { validateStoredItem, validateStoredItemBatch } from '../validation.js';
import { resolvePublicHttpUrl } from '../safe-url.js';
import { sentenceLookupHash } from '../sentence-enrichment.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const REVIEW_RATINGS = ['again', 'hard', 'good', 'easy'];
const REVIEW_TASKS = ['meaning', 'production', 'cloze', 'listening', 'quick'];

function hasValidReviewMetadata(event: any): boolean {
  return (event.rating === undefined || REVIEW_RATINGS.includes(event.rating)) &&
    (event.taskType === undefined || REVIEW_TASKS.includes(event.taskType)) &&
    (event.durationMs === undefined || (Number.isInteger(event.durationMs) && event.durationMs >= 0 && event.durationMs <= 86_400_000)) &&
    (event.sessionId === undefined || (typeof event.sessionId === 'string' && event.sessionId.length <= 200));
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length);
}

/** Fetch an image URL and return as base64 data URI, or undefined on failure. */
async function fetchImageAsBase64(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    let current = url;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const parsed = await resolvePublicHttpUrl(current);
      response = await proxyFetch(parsed.toString(), { signal: controller.signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) return undefined;
      current = new URL(location, parsed).toString();
    }
    if (!response?.ok) return undefined;
    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (declaredLength > MAX_IMAGE_BYTES) return undefined;
    const bytes = await readLimitedBody(response, MAX_IMAGE_BYTES);
    if (!bytes) return undefined;
    const mimeType = detectImageMimeType(bytes);
    if (!mimeType) return undefined;
    const base64 = bytes.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap a plain VocabCard object into a full StoredItem. */
function wrapVocabCard(card: any): any {
  const id = typeof card.id === 'string' && card.id.length > 0 && card.id.length <= 200 ? card.id : randomUUID();
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
  };
}

type ItemsEnv = { Variables: AuthVariables };

export const itemsRoutes = new Hono<ItemsEnv>();

// Prepared example metadata is global source material. Looking it up must not create a user item:
// expanding an example is a read-only action, while bookmarking remains an explicit save.
itemsRoutes.post('/sentence-enrichments/lookup', async (c) => {
  const body = await c.req.json().catch(() => null);
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
    return c.json({ error: 'Expected a non-empty sentence' }, 400);
  }
  const enrichment = getSentenceEnrichmentForText(text);
  if (!enrichment) return c.json({ found: false });
  const lookupHash = sentenceLookupHash(text);
  c.header('Cache-Control', 'private, max-age=300');
  return c.json({
    found: true,
    analysis: enrichment.analysis,
    analysisGeneratedAt: enrichment.generatedAt,
    ...(enrichment.imageContentHash && enrichment.imageMimeType
      ? { imageUrl: `/api/sentence-enrichments/${lookupHash}/image` }
      : {}),
  });
});

itemsRoutes.get('/sentence-enrichments/:lookupHash/image', (c) => {
  const image = getSentenceEnrichmentImage(c.req.param('lookupHash'));
  if (!image) return c.notFound();
  return new Response(image.data, {
    headers: {
      'Content-Type': image.mimeType,
      'Cache-Control': 'private, max-age=86400',
    },
  });
});

function streamAllItems(c: Context<ItemsEnv>, userId: string) {
  c.header('Content-Type', 'application/json; charset=UTF-8');
  return stream(c, async output => {
    let cursor = { revision: 0, id: '' };
    let first = true;
    let pageCount = 0;
    await output.write('[');
    for (;;) {
      const page = getItemsAfterRevision(cursor, 200, true, userId);
      if (page.items.length > 0) {
        const body = JSON.stringify(page.items).slice(1, -1);
        if (body) {
          await output.write(`${first ? '' : ','}${body}`);
          first = false;
        }
      }
      if (!page.hasMore) break;
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
    if (!Number.isSafeInteger(revision) || revision < 0 || afterId.length > 200 ||
        !Number.isSafeInteger(limit) || limit < 1) {
      return c.json({ error: 'Invalid revision cursor' }, 400);
    }
    return c.json(getItemsAfterRevision({ revision, id: afterId }, limit, true, userId));
  }
  const since = c.req.query('since');
  if (since) {
    const ts = parseInt(since, 10);
    if (isNaN(ts)) return c.json({ error: 'Invalid since parameter' }, 400);
    return c.json(getItemsSince(ts, true, userId));
  }
  // Keep the legacy array response contract, but serialize bounded pages into a stream. A large
  // regenerated corpus must not monopolize the single Node event loop during JSON conversion.
  return streamAllItems(c, userId);
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
      // This is authenticated, user-owned content and the image may be regenerated
      // at the same URL. Never allow a shared cache or immutable stale response.
      'Cache-Control': 'private, max-age=300, must-revalidate',
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
  const capped = Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))).slice(0, 20);
  if (capped.length === 0) return c.json({ error: 'Expected valid image ids' }, 400);
  const images = getItemImagesBatch(capped, userId);
  return c.json(images);
});

// GET /api/items/images/manifest — ids of every image this user has stored.
// Lightweight (ids only); the client diffs this against its IndexedDB to know what to re-upload.
// Registered before GET /items/:id so the literal path isn't captured as an :id.
itemsRoutes.get('/items/images/manifest', (c) => {
  const userId = c.get('user').id;
  return c.json(getImageManifest(userId));
});

// PUT /api/items/images — upload base64 images straight into item_images.
// Body: { [id]: 'data:image/...;base64,...' }. Used by upload-on-create and the recovery action.
// Registered before PUT /items/:id and PUT /items so it isn't shadowed.
itemsRoutes.put('/items/images', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Expected { [id]: dataUri }' }, 400);
  }
  const MAX_ENTRIES = 25;
  const MAX_LEN = 14 * 1024 * 1024; // ~10MB binary encoded as base64
  const images: Array<{ id: string; data: string }> = [];
  for (const [id, val] of Object.entries(body)) {
    if (images.length >= MAX_ENTRIES) break;
    if (id.length > 0 && id.length <= 200 && typeof val === 'string' &&
        /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/.test(val) && val.length <= MAX_LEN) {
      images.push({ id, data: val });
    }
  }
  if (images.length === 0) return c.json({ error: 'No valid images' }, 400);
  const saved = upsertItemImages(images, userId);
  return c.json({ ok: true, saved });
});

// Binary image upload. New clients use this to avoid base64/JSON expansion;
// the batch JSON endpoint remains temporarily for older deployed clients.
itemsRoutes.put('/items/:id/image', async (c) => {
  const userId = c.get('user').id;
  const mimeType = (c.req.header('content-type') || '').split(';', 1)[0].toLowerCase();
  if (!/^image\/(?:avif|gif|jpeg|png|webp)$/.test(mimeType)) {
    return c.json({ error: 'Unsupported image type' }, 415);
  }
  const declaredLength = Number(c.req.header('content-length') || '0');
  if (declaredLength > MAX_IMAGE_BYTES) return c.json({ error: 'Image is too large' }, 413);
  const bytes = Buffer.from(await c.req.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    return c.json({ error: 'Invalid image size' }, 413);
  }
  if (!upsertItemImageBinary(c.req.param('id'), bytes, mimeType, userId)) {
    return c.json({ error: 'Image could not be stored' }, 400);
  }
  return c.json({ ok: true });
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
  const body = await c.req.json().catch(() => null);
  const validationError = validateStoredItem(body);
  if (validationError) return c.json({ error: validationError }, 400);
  const id = c.req.param('id');
  if (!id || id.length > 200) return c.json({ error: 'Invalid item id' }, 400);
  // Ensure URL param matches body
  body.data.id = id;
  body.srs.id = id;
  try {
    const result = upsertItem(body, userId);
    return c.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Error && error.message.includes('belongs to another user')) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
});

// PUT /api/items — batch upsert (array of items)
itemsRoutes.put('/items', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json().catch(() => null);
  const validationError = validateStoredItemBatch(body, 500);
  if (validationError) return c.json({ error: validationError }, 400);
  try {
    const result = upsertMany(body, userId);
    // Return server-enriched sentences immediately instead of waiting for the next 8-second delta pull.
    // Conflicts use this same bounded canonical response path.
    const canonicalIds = new Set(result.conflicts);
    for (const item of body) {
      if (item.type !== 'sentence' || item.isDeleted || item.data?.analysis) continue;
      const stored = getItemById(item.data.id, userId, false);
      if (stored?.data?.analysis) canonicalIds.add(item.data.id);
    }
    const canonical = [...canonicalIds]
      .map(id => getItemById(id, userId, false))
      .filter(Boolean);
    return c.json({ ok: true, count: body.length, ...result, canonical });
  } catch (error) {
    if (error instanceof Error && error.message.includes('belongs to another user')) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
});

// DELETE /api/items/:id — soft delete
itemsRoutes.delete('/items/:id', (c) => {
  const userId = c.get('user').id;
  const id = c.req.param('id');
  if (!id || id.length > 200) return c.json({ error: 'Invalid item id' }, 400);
  softDeleteItem(id, userId);
  return c.json({ ok: true });
});

// POST /api/import — bulk import
// Accepts either:
//   1. StoredItem[] (full format with data/type/srs wrappers)
//   2. VocabCard[] (simplified — just word/chinese/definition/etc, auto-wrapped)
// If imageUrl is an HTTP URL, fetches and converts to base64.
itemsRoutes.post('/import', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.json({ error: 'Expected array of items' }, 400);
  }
  if (body.length > 5_000) return c.json({ error: 'Import is limited to 5000 items' }, 400);

  // Normalize: detect simplified VocabCard format and wrap
  const items: any[] = body.map((item: any) => {
    if (item && item.data && item.type) return item; // already StoredItem
    if (item && typeof item.word === 'string' && item.word.trim()) return wrapVocabCard(item); // plain VocabCard
    return null;
  }).filter((item): item is any => !!item && validateStoredItem(item) === null);

  if (items.length === 0) {
    return c.json({ error: 'No valid items found' }, 400);
  }

  // Fetch HTTP image URLs → base64 (concurrently, max 5 at a time)
  let imagesFetched = 0;
  const remoteImageItems = items.filter((i: any) => {
    const url = i.data?.imageUrl;
    return url && typeof url === 'string' && url.startsWith('http');
  });
  const imageItems = remoteImageItems.slice(0, 100);
  for (const item of remoteImageItems.slice(100)) delete item.data.imageUrl;

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
  let nestedImagesAttempted = imageItems.length;
  for (const item of items) {
    if (Array.isArray(item.data?.vocabs)) {
      for (const vocab of item.data.vocabs) {
        if (vocab.imageUrl && typeof vocab.imageUrl === 'string' && vocab.imageUrl.startsWith('http')) {
          if (nestedImagesAttempted >= 100) {
            delete vocab.imageUrl;
            continue;
          }
          nestedImagesAttempted++;
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

// Append-only review history. The event id makes retries idempotent.
itemsRoutes.get('/reviews', (c) => {
  const userId = c.get('user').id;
  const since = Number(c.req.query('since') || Date.now() - 366 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(since) || since < 0) return c.json({ error: 'Invalid since parameter' }, 400);
  return c.json(getReviewEvents(userId, since));
});

itemsRoutes.post('/reviews', async (c) => {
  const userId = c.get('user').id;
  const event = await c.req.json().catch(() => null);
  if (!event || typeof event.id !== 'string' || typeof event.itemId !== 'string' ||
      !['vocab', 'phrase', 'sentence'].includes(event.itemType) ||
      !Number.isFinite(event.reviewedAt) || !Number.isInteger(event.previousStep) ||
      !Number.isInteger(event.nextStep) || !hasValidReviewMetadata(event)) {
    return c.json({ error: 'Invalid review event' }, 400);
  }
  addReviewEvent(event, userId);
  return c.json({ ok: true }, 201);
});

// Atomically append an idempotent review event and advance the latest server schedule.
// Older clients may keep using POST /reviews + PUT /items during the compatibility window.
itemsRoutes.post('/reviews/apply', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json().catch(() => null);
  const event = body?.event;
  const itemIds = body?.itemIds;
  const seedItem = body?.seedItem;
  if (!event || typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 200 ||
      typeof event.itemId !== 'string' || event.itemId.length === 0 || event.itemId.length > 200 ||
      !['vocab', 'phrase', 'sentence'].includes(event.itemType) ||
      !Number.isFinite(event.reviewedAt) || event.reviewedAt < 0 ||
      !Number.isInteger(event.previousStep) || event.previousStep < 0 ||
      !Number.isInteger(event.nextStep) || event.nextStep < 0 ||
      !hasValidReviewMetadata(event) ||
      !Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 100 ||
      !itemIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
    return c.json({ error: 'Invalid review mutation' }, 400);
  }
  if (seedItem !== undefined) {
    const validationError = validateStoredItem(seedItem);
    if (validationError || seedItem.data.id !== event.itemId || seedItem.type !== event.itemType ||
        seedItem.srs.id !== event.itemId || seedItem.srs.totalReviews !== event.previousStep) {
      return c.json({ error: validationError ? `Invalid review seed: ${validationError}` : 'Review seed does not match event' }, 400);
    }
  }
  try {
    // Catalog sentences are implicit until their first review. Seed the base item before applying the
    // idempotent event so an offline/retried first review cannot race the ordinary item sync or advance
    // the schedule twice. Existing items always win; the seed is used only for a genuinely absent id.
    if (seedItem !== undefined && !getItemById(event.itemId, userId, false)) {
      upsertItem(seedItem, userId);
    }
    const result = applyReviewEvent(event, itemIds, userId);
    if (!result) return c.json({ error: 'Review item not found' }, 404);
    return c.json(result, result.applied ? 201 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Review could not be applied';
    if (message.includes('belongs to another user')) return c.json({ error: message }, 409);
    throw error;
  }
});

itemsRoutes.post('/reviews/:id/undo', (c) => {
  const userId = c.get('user').id;
  const eventId = c.req.param('id');
  if (!eventId || eventId.length > 200) return c.json({ error: 'Invalid review event id' }, 400);
  try {
    const result = undoReviewEvent(eventId, userId);
    if (!result) return c.json({ error: 'Review event not found' }, 404);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Review could not be undone';
    if (message.includes('belongs to another user') || message.includes('cannot be undone') ||
        message.includes('no longer the latest')) {
      return c.json({ error: message }, 409);
    }
    throw error;
  }
});
