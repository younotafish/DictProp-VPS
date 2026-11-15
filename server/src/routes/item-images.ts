import { Hono, type Context } from 'hono';
import { getImageManifest, getItemImageBinary, storeItemImage } from '../db.js';
import { isSupportedImageMime } from '../image-format.js';
import type { AppEnv } from '../middleware/auth.js';
import { isItemId } from '../validation.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

export const itemImageRoutes = new Hono<AppEnv>();

/** If-None-Match compares weakly, so a W/ prefix added by an intermediary still matches. */
function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  return !!header && header.split(',').some(tag => {
    const value = tag.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}

/** An image's bytes, or a 304 when the client's copy has the same content hash. */
export function imageResponse(c: Context, image: { data: Buffer; mimeType: string; contentHash: string }): Response {
  const headers = {
    // The content hash names these exact bytes, so revalidation costs a 304 instead of the image.
    ETag: `"${image.contentHash}"`,
    // This is authenticated, user-owned content and the image may be regenerated
    // at the same URL. Never allow a shared cache or immutable stale response.
    'Cache-Control': 'private, max-age=300, must-revalidate',
  };
  if (ifNoneMatchHits(c.req.header('if-none-match'), headers.ETag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(image.data, { headers: { ...headers, 'Content-Type': image.mimeType } });
}

// GET /api/items/:id/image — return raw binary image with caching headers
itemImageRoutes.get('/items/:id/image', (c) => {
  const userId = c.get('user').id;
  // Raster types only: never serve a stored SVG (a script-capable document) from this origin.
  const image = getItemImageBinary(c.req.param('id'), userId);
  if (!image) return c.json({ error: 'Not found' }, 404);
  return imageResponse(c, image);
});

// GET /api/items/images/manifest — ids of every image this user has stored.
// Lightweight (ids only); the client diffs this against its IndexedDB to know what to re-upload.
itemImageRoutes.get('/items/images/manifest', (c) => {
  const userId = c.get('user').id;
  return c.json(getImageManifest(userId));
});

// PUT /api/items/:id/image — binary image upload, without base64/JSON expansion.
itemImageRoutes.put('/items/:id/image', async (c) => {
  const userId = c.get('user').id;
  const id = c.req.param('id');
  if (!isItemId(id)) return c.json({ error: 'Invalid item id' }, 400);
  const mimeType = (c.req.header('content-type') || '').split(';', 1)[0].toLowerCase();
  if (!isSupportedImageMime(mimeType)) {
    return c.json({ error: 'Unsupported image type' }, 415);
  }
  const declaredLength = Number(c.req.header('content-length') || '0');
  if (declaredLength > MAX_IMAGE_BYTES) return c.json({ error: 'Image is too large' }, 413);
  const bytes = Buffer.from(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.json({ error: 'Image is empty' }, 400);
  if (bytes.length > MAX_IMAGE_BYTES) return c.json({ error: 'Image is too large' }, 413);
  // The image and the revisions that announce it commit together, or a delta client could miss it.
  const stored = storeItemImage(id, bytes, mimeType, userId);
  if (stored === 'invalid') return c.json({ error: `Image is not a valid ${mimeType}` }, 415);
  if (stored === 'forbidden') return c.json({ error: 'Image id belongs to another user' }, 409);
  return c.json({ ok: true });
});
