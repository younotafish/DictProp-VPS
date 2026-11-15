import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { upsertMany } from '../db.js';
import { detectImageMimeType } from '../image-format.js';
import type { AppEnv } from '../middleware/auth.js';
import { readJsonArray } from '../middleware/json-body.js';
import { fetchPublicHttpUrl } from '../safe-url.js';
import { isItemId, validateStoredItem } from '../validation.js';
import { isRecord } from '../validation-helpers.js';
import { MAX_IMAGE_BYTES } from './item-images.js';

const IMAGE_FETCH_TIMEOUT_MS = 30_000;

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
    const response = await fetchPublicHttpUrl(url, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
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
function wrapVocabCard(card: Record<string, unknown>) {
  const id = isItemId(card.id) ? card.id : randomUUID();
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

/** An import entry once it is a StoredItem: its data, and a phrase's vocabs, are open JSON objects. */
interface ImportedItem {
  type: string;
  data: Record<string, unknown> & { imageUrl?: unknown; vocabs?: unknown };
  srs: object;
}

export interface ImportRouteDependencies {
  /** Fetch a remote image as a data URI, or undefined when it can't be had. */
  fetchImage?: (url: string) => Promise<string | undefined>;
}

export function createImportRoutes({ fetchImage = fetchImageAsBase64 }: ImportRouteDependencies = {}) {
  const importRoutes = new Hono<AppEnv>();

  // POST /api/import — bulk import
  // Accepts either:
  //   1. StoredItem[] (full format with data/type/srs wrappers)
  //   2. VocabCard[] (simplified — just word/chinese/definition/etc, auto-wrapped)
  // If imageUrl is an HTTP URL, fetches and converts to base64.
  importRoutes.post('/import', async (c) => {
    const userId = c.get('user').id;
    const body = await readJsonArray(c);
    if (!body) {
      return c.json({ error: 'Expected array of items' }, 400);
    }
    if (body.length > 5_000) return c.json({ error: 'Import is limited to 5000 items' }, 400);

    // Normalize: detect simplified VocabCard format and wrap
    const normalize = (item: unknown): object | null => {
      if (!isRecord(item)) return null;
      if (item.data && item.type) return item; // already StoredItem
      if (typeof item.word === 'string' && item.word.trim()) return wrapVocabCard(item); // plain VocabCard
      return null;
    };
    // validateStoredItem checked the shape of every item kept.
    const items = body.map(normalize).filter(item => !!item && validateStoredItem(item) === null) as ImportedItem[];

    if (items.length === 0) {
      return c.json({ error: 'No valid items found' }, 400);
    }

    // Fetch HTTP image URLs → base64 (concurrently, max 5 at a time)
    let imagesFetched = 0;
    const remoteImageItems = items.filter(i => {
      const url = i.data?.imageUrl;
      return url && typeof url === 'string' && url.startsWith('http');
    });
    const imageItems = remoteImageItems.slice(0, 100);
    for (const item of remoteImageItems.slice(100)) delete item.data.imageUrl;

    // Process in batches of 5
    for (let i = 0; i < imageItems.length; i += 5) {
      const batch = imageItems.slice(i, i + 5);
      await Promise.all(
        batch.map(async item => {
          const base64 = await fetchImage(item.data.imageUrl as string);
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
            const base64 = await fetchImage(vocab.imageUrl);
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

  return importRoutes;
}

export const importRoutes = createImportRoutes();
