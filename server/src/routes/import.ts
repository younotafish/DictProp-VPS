import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { upsertMany } from '../db.js';
import { detectImageMimeType } from '../image-format.js';
import type { AppEnv } from '../middleware/auth.js';
import { readJsonArray } from '../middleware/json-body.js';
import { fetchPublicHttpUrl } from '../safe-url.js';
import { runPool } from '../shared/pool.js';
import { checkStoredItem, isItemId } from '../validation.js';
import { isRecord } from '../validation-helpers.js';
import { MAX_IMAGE_BYTES } from './item-images.js';

const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const MAX_IMPORT_IMAGES = 100;
const IMAGE_FETCH_CONCURRENCY = 5;
// The image phase's budget as a whole: past it no picture starts and those still downloading are cut off, so slow
// picture hosts can't hold the cards and the reply past the client's 12-minute wait (services/api/jsonImport.ts).
const IMAGE_PHASE_DEADLINE_MS = 8 * 60_000;

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

/** Fetch an image URL and return as base64 data URI, or undefined on failure, after 30 s or once `signal` aborts. */
async function fetchImageAsBase64(url: string, signal: AbortSignal): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchPublicHttpUrl(url, { signal: AbortSignal.any([controller.signal, signal]) });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (declaredLength > MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      return undefined;
    }
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

export interface ImportRouteDependencies {
  /** Fetch a remote image as a data URI, or undefined when it can't be had or `signal` aborts first. */
  fetchImage?: (url: string, signal: AbortSignal) => Promise<string | undefined>;
  /** How long the image phase may run in all; tests shorten it. */
  imagePhaseDeadlineMs?: number;
}

export function createImportRoutes({
  fetchImage = fetchImageAsBase64,
  imagePhaseDeadlineMs = IMAGE_PHASE_DEADLINE_MS,
}: ImportRouteDependencies = {}) {
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
    const items = body.map(normalize).flatMap((item) => {
      const checked = checkStoredItem(item);
      return 'item' in checked ? [checked.item] : [];
    });

    if (items.length === 0) {
      return c.json({ error: 'No valid items found' }, 400);
    }

    // Every remote image URL, the items' own first and then their phrase vocabs', in order. The first 100 are
    // fetched into data URIs, a few at a time, until the image phase's deadline; the rest, any that fail and any the
    // deadline leaves unfetched lose their URL so it doesn't break the client.
    const isRemote = (url: unknown): url is string => !!url && typeof url === 'string' && url.startsWith('http');
    const holders: Array<Record<string, unknown>> = items.filter(item => isRemote(item.data.imageUrl)).map(item => item.data);
    for (const item of items) {
      if (Array.isArray(item.data.vocabs)) {
        for (const vocab of item.data.vocabs) if (isRecord(vocab) && isRemote(vocab.imageUrl)) holders.push(vocab);
      }
    }
    for (const holder of holders.slice(MAX_IMPORT_IMAGES)) delete holder.imageUrl;
    const fetching = holders.slice(0, MAX_IMPORT_IMAGES);
    let imagesFetched = 0;
    // At the deadline the pool starts no further fetch, and the fetches in flight are aborted.
    const deadline = AbortSignal.timeout(imagePhaseDeadlineMs);
    await runPool(fetching, IMAGE_FETCH_CONCURRENCY, async (holder) => {
      const base64 = await fetchImage(holder.imageUrl as string, deadline);
      if (base64) {
        holder.imageUrl = base64;
        imagesFetched++;
      } else {
        delete holder.imageUrl;
      }
    }, deadline);
    for (const holder of fetching) if (isRemote(holder.imageUrl)) delete holder.imageUrl;

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
