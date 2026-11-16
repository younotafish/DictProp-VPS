import { ConflictError } from '../errors.js';
import { serverImageMarker } from '../shared/image-markers.js';
import { keepServerOwnedData } from '../shared/server-owned-data.js';
import type { ItemType } from '../validation-helpers.js';
import { db, writeTransaction } from './connection.js';
import {
  getItemImagesBatch, hasItemImage, imageStmts, linkSentenceEnrichmentImage, storeImage, storeImageBuffer,
  type ImageStoreResult,
} from './images.js';
import {
  isJsonObject, isStaleContent, resolveSrs, sameJson, splitInlineImages, withPoolAnalysis, type InlineImage, type JsonObject,
} from './item-write.js';
import { allocateRevision, headRevision } from './revisions.js';
import { getSentenceEnrichmentForText } from './sentence-enrichments.js';

// The library's item rows and every read and write of them.

export const stmts = {
  getAllChunk: db.prepare(`SELECT rowid AS _rowid, * FROM items WHERE user_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`),
  getAfterRevision: db.prepare(`SELECT * FROM items
    WHERE user_id = ? AND (revision > ? OR (revision = ? AND id > ?))
    ORDER BY revision, id LIMIT ?`),
  upsert: db.prepare(`
    INSERT INTO items (id, type, data, srs, saved_at, updated_at, is_deleted, is_archived, user_id, project, revision)
    VALUES (@id, @type, @data, @srs, @saved_at, @updated_at, @is_deleted, @is_archived, @user_id, @project, @revision)
    ON CONFLICT(id) DO UPDATE SET
      type = @type,
      data = @data,
      srs = @srs,
      saved_at = @saved_at,
      updated_at = @updated_at,
      is_deleted = @is_deleted,
      is_archived = @is_archived,
      project = @project,
      revision = @revision
    WHERE items.user_id IS NULL OR items.user_id = @user_id
  `),
  softDelete: db.prepare(`UPDATE items SET is_deleted = 1, updated_at = ?, revision = ? WHERE id = ? AND user_id = ?`),
  existsScoped: db.prepare(`SELECT 1 FROM items WHERE id = ? AND user_id = ?`),
  getByIdScoped: db.prepare(`SELECT * FROM items WHERE id = ? AND user_id = ?`),
  getById: db.prepare(`SELECT * FROM items WHERE id = ?`),
  updateSrs: db.prepare(`UPDATE items SET srs = ?, updated_at = ?, revision = ? WHERE id = ? AND user_id = ?`),
  // Reviews record their item's id and the time the review set as the schedule's lastReviewDate.
  undoneReviewAt: db.prepare(`SELECT 1 FROM review_events
    WHERE user_id = ? AND reviewed_at = ? AND item_id = ? AND undone_at IS NOT NULL LIMIT 1`),
};

// Row → StoredItem JSON
export interface ItemRow {
  id: string;
  type: ItemType;
  data: string;
  srs: string;
  saved_at: number;
  updated_at: number | null;
  is_deleted: number;
  is_archived: number;
  user_id: string | null;
  project: string | null;
  revision: number;
}

// Item data is open JSON, which the routes send on and the scripts read field by field: `any` at this one boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
function rowToItem(row: ItemRow, data: any = JSON.parse(row.data)) {
  return {
    type: row.type,
    data,
    srs: JSON.parse(row.srs),
    savedAt: row.saved_at,
    updatedAt: row.updated_at ?? undefined,
    isDeleted: row.is_deleted === 1 ? true : undefined,
    isArchived: row.is_archived === 1 ? true : undefined,
    serverRevision: row.revision || undefined,
  };
}

/** An item as the API sends it. */
export type ItemRead = ReturnType<typeof rowToItem>;

/**
 * Rows → StoredItem JSON without image bytes. An image in item_images becomes a marker with a content
 * version, so clients can invalidate an older IndexedDB copy after a replacement. One indexed lookup
 * covers every image on the page.
 */
function rowsToItems(rows: ItemRow[], userId: string) {
  const parsed = rows.map(row => ({ row, data: JSON.parse(row.data) }));
  const imageIds = parsed.flatMap(({ data }) => [
    data.id,
    ...(Array.isArray(data.vocabs) ? data.vocabs.map((vocab: unknown) => (isJsonObject(vocab) ? vocab.id : undefined)) : []),
  ]).filter((id): id is string => typeof id === 'string');
  const versions = new Map<string, string>();
  if (imageIds.length > 0) {
    const images = imageStmts.versionsForIds.all(userId, JSON.stringify(imageIds)) as Array<{
      id: string;
      content_hash: string | null;
      updated_at: number;
    }>;
    for (const image of images) {
      versions.set(image.id, (image.content_hash || `legacy-${image.updated_at}`).slice(0, 20));
    }
  }
  const markerFor = (id: unknown): string | null => {
    const version = typeof id === 'string' ? versions.get(id) : undefined;
    return version ? serverImageMarker(version) : null;
  };
  return parsed.map(({ row, data }) => {
    const topMarker = markerFor(data.id);
    if (topMarker) data.imageUrl = topMarker;
    if (Array.isArray(data.vocabs)) {
      data.vocabs = data.vocabs.map((vocab: unknown) => {
        if (!isJsonObject(vocab)) return vocab;
        const marker = markerFor(vocab.id);
        return marker ? { ...vocab, imageUrl: marker } : vocab;
      });
    }
    return rowToItem(row, data);
  });
}

export function getAllItems(userId: string) {
  const CHUNK = 500;
  const items: ItemRead[] = [];
  let lastRowId = 0;
  for (;;) {
    const rows = stmts.getAllChunk.all(userId, lastRowId, CHUNK) as Array<ItemRow & { _rowid: number }>;
    if (rows.length === 0) break;
    for (const item of rowsToItems(rows, userId)) items.push(item);
    lastRowId = rows[rows.length - 1]._rowid;
  }
  return items;
}

// All distinct speakable sentence texts across ALL users' non-deleted items (vocab examples, phrase
// vocab examples, saved sentence text). Used by the TTS backfill (the audio cache is global by
// voice+text, so it's not user-scoped). Streams rows to keep memory low. Texts keep their {{}}/[[]]
// markers — the caller strips them to match the client's cache key.
export function getAllSentenceTexts(): string[] {
  const texts = new Set<string>();
  const add = (t: unknown) => { if (typeof t === 'string' && t.trim()) texts.add(t.trim()); };
  const stmt = db.prepare(`SELECT data FROM items WHERE is_deleted IS NOT 1`);
  for (const row of stmt.iterate() as Iterable<{ data: string }>) {
    let d: unknown;
    try { d = JSON.parse(row.data); } catch { continue; }
    if (!isJsonObject(d)) continue;
    if (Array.isArray(d.examples)) d.examples.forEach(add);                                  // vocab card
    if (Array.isArray(d.vocabs)) for (const v of d.vocabs) if (Array.isArray(v?.examples)) v.examples.forEach(add); // phrase
    if (typeof d.text === 'string') add(d.text);                                             // saved sentence
  }
  return [...texts];
}

export interface RevisionCursor {
  revision: number;
  id: string;
}

/**
 * One page of the user's items in revision order after the cursor. headRevision is the newest revision
 * the server has issued, so a cursor past it came from a database that has since been replaced.
 */
export function getItemsAfterRevision(
  cursor: RevisionCursor,
  limit: number,
  userId: string,
): { items: ItemRead[]; cursor: RevisionCursor; hasMore: boolean; headRevision: number } {
  const cappedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const rows = stmts.getAfterRevision.all(
    userId,
    cursor.revision,
    cursor.revision,
    cursor.id,
    cappedLimit + 1,
  ) as ItemRow[];
  const hasMore = rows.length > cappedLimit;
  const page = hasMore ? rows.slice(0, cappedLimit) : rows;
  const last = page[page.length - 1];
  return {
    items: rowsToItems(page, userId),
    cursor: last ? { revision: last.revision, id: last.id } : cursor,
    hasMore,
    headRevision: headRevision(),
  };
}

export interface UpsertResult { revision: number; conflicted: boolean }

export interface UpsertOptions {
  /**
   * The write is the whole item, so a server-owned field it omits is removed instead of kept from the
   * stored row. Only the corpus-audit import writes items this way: its data must match audited hashes.
   */
  replaceServerFields?: boolean;
}

/** An item as a client or an importer writes it. The item routes validate this shape; importers build it. */
export interface ItemWrite {
  type: string;
  data: object;
  srs: object;
  savedAt?: number;
  updatedAt?: number;
  serverRevision?: number;
  isDeleted?: boolean;
  isArchived?: boolean;
}

export function writeItem(item: ItemWrite, userId: string, options: UpsertOptions): UpsertResult & {
  id: string;
  enriched: boolean;
} {
  const incoming = item.data as JsonObject;
  if (!incoming || !incoming.id) throw new Error('Item missing data.id');
  const id = String(incoming.id);

  const now = Date.now();
  const existing = stmts.getById.get(id) as ItemRow | undefined;
  if (existing?.user_id && existing.user_id !== userId) {
    throw new ConflictError('Item id belongs to another user');
  }

  const incomingUpdatedAt = item.updatedAt || now;
  const existingUpdatedAt = existing?.updated_at || 0;
  const existingRevision = existing?.revision || 0;

  const storedSrs: unknown = existing ? JSON.parse(existing.srs) : undefined;
  const isUndoneReview = (lastReviewDate: number) => !!stmts.undoneReviewAt.get(userId, lastReviewDate, id);
  const { srs, changed: srsChanged } = existing
    ? resolveSrs(storedSrs, item.srs, isUndoneReview)
    : { srs: item.srs, changed: false };
  const staleContent = !!existing && isStaleContent({
    storedRevision: existingRevision,
    incomingRevision: typeof item.serverRevision === 'number' ? item.serverRevision : undefined,
    storedUpdatedAt: existingUpdatedAt,
    incomingUpdatedAt,
  });

  // A prepared example sentence upgrades itself when it is saved. This lookup is tiny and indexed;
  // the full enrichment pool never enters normal item reads. Preserve any explicit item analysis.
  const pool = !staleContent && item.type === 'sentence' && !item.isDeleted && typeof incoming.text === 'string'
    ? getSentenceEnrichmentForText(incoming.text)
    : null;
  const { data: analysed, enriched } = withPoolAnalysis(incoming, pool);

  // After the pool, which returns the sentence it analyses to the saving client. Kept fields aren't returned.
  const keepFrom = existing && existing.is_deleted !== 1 && !staleContent && !item.isDeleted && !options.replaceServerFields
    ? existing
    : undefined;
  const storedData: unknown = keepFrom ? JSON.parse(keepFrom.data) : undefined;
  const data = keepFrom ? keepServerOwnedData(analysed, item.type, storedData, keepFrom.type) : analysed;
  const keptServerFields = data !== analysed;

  // A stale copy's content lost to the stored row, so its images only fill ids that have none: a newer
  // stored image stays.
  const storeInlineImage = (image: InlineImage | undefined): boolean =>
    !!image && (!staleContent || !hasItemImage(image.id, userId)) && storeImage(image.id, userId, image.dataUri, now);

  // The item's own inline image goes first, so the pool's image only fills an item that has none.
  const { stored, itemImage, vocabImages } = splitInlineImages(data);
  let imagesChanged = storeInlineImage(itemImage);
  if (pool && linkSentenceEnrichmentImage(id, userId, pool.imageContentHash, pool.imageMimeType, now)) {
    imagesChanged = true;
  }
  for (const image of vocabImages) {
    if (storeInlineImage(image)) imagesChanged = true;
  }

  const content = staleContent && existing
    ? {
        type: existing.type,
        data: existing.data,
        saved_at: existing.saved_at,
        is_deleted: existing.is_deleted,
        is_archived: existing.is_archived,
      }
    : {
        type: item.type,
        data: JSON.stringify(stored),
        saved_at: item.savedAt || now,
        is_deleted: item.isDeleted ? 1 : 0,
        is_archived: item.isArchived ? 1 : 0,
      };
  const row = {
    id,
    ...content,
    srs: JSON.stringify(srs),
    updated_at: staleContent && !srsChanged ? existingUpdatedAt : Math.max(existingUpdatedAt, incomingUpdatedAt),
    user_id: userId,
    project: null,
  };
  // A copy that differs from the row only by lacking kept fields changes nothing. Its client keeps its own
  // data at an unchanged revision and pushes that copy again, so a revision per push would never settle.
  // The JSON columns compare by content: kept fields come back in their own order, and a schedule can too.
  const sameColumn = (key: keyof typeof row) =>
    key === 'data' ? sameJson(stored, storedData) : key === 'srs' ? sameJson(srs, storedSrs) : row[key] === existing?.[key];
  if (existing && keptServerFields && !imagesChanged && !enriched && (Object.keys(row) as Array<keyof typeof row>).every(sameColumn)) {
    return { id, revision: existingRevision, conflicted: false, enriched: false };
  }
  // An image a stale copy fills in still needs a revision, or delta clients would never see its marker.
  const revision = staleContent && !srsChanged && !imagesChanged ? existingRevision : allocateRevision();
  stmts.upsert.run({ ...row, revision });
  return { id, revision, conflicted: staleContent, enriched };
}

// The item row, its captured images and its revision commit together.
const writeItemTransaction = writeTransaction(writeItem);

export function upsertItem(item: ItemWrite, userId: string, options: UpsertOptions = {}): UpsertResult {
  const { revision, conflicted } = writeItemTransaction(item, userId, options);
  return { revision, conflicted };
}

/** `enriched` lists the sentences the example-enrichment pool just gave an analysis. */
export const upsertMany = writeTransaction((items: ItemWrite[], userId: string, options: UpsertOptions = {}): {
  revisions: Record<string, number>;
  conflicts: string[];
  enriched: string[];
} => {
  const revisions: Record<string, number> = {};
  const conflicts: string[] = [];
  const enriched: string[] = [];
  for (const item of items) {
    const result = writeItem(item, userId, options);
    if (result.conflicted) conflicts.push(result.id);
    else revisions[result.id] = result.revision;
    if (result.enriched) enriched.push(result.id);
  }
  return { revisions, conflicts, enriched };
});

export const softDeleteItem = writeTransaction((id: string, userId: string): boolean => {
  // Deleting an id the user doesn't have changes nothing, so it must not advance the revision clock.
  if (!stmts.existsScoped.get(id, userId)) return false;
  stmts.softDelete.run(Date.now(), allocateRevision(), id, userId);
  return true;
});

export function getItemById(id: string, userId: string, includeImages = true) {
  const row = stmts.getByIdScoped.get(id, userId) as ItemRow | undefined;
  if (!row) return null;
  if (!includeImages) return rowsToItems([row], userId)[0];
  const item = rowToItem(row);
  // Re-inject base64 from item_images for this single item.
  const d = item.data;
  const ids = [d.id, ...(Array.isArray(d.vocabs) ? d.vocabs.map((v: { id: unknown }) => v.id) : [])].filter(Boolean);
  const imgs = getItemImagesBatch(ids, userId);
  if (imgs[d.id]) d.imageUrl = imgs[d.id];
  if (Array.isArray(d.vocabs)) for (const v of d.vocabs) if (imgs[v.id]) v.imageUrl = imgs[v.id];
  return item;
}

const touchStmts = {
  phrasesMentioning: db.prepare(`SELECT id, data FROM items WHERE user_id = ? AND type = 'phrase' AND data LIKE ?`),
  bump: db.prepare(`UPDATE items SET revision = ? WHERE id = ? AND user_id = ?`),
};

/**
 * Image bytes live outside item rows, so storing one changes no revision. Bump every item that shows
 * one of these images, itself or as a phrase vocab, so revision-delta clients pick up its new marker.
 */
export const touchItemRevisions = writeTransaction((imageIds: readonly string[], userId: string): void => {
  const owners = new Set<string>();
  for (const imageId of new Set(imageIds)) {
    if (stmts.existsScoped.get(imageId, userId)) owners.add(imageId);
    const phrases = touchStmts.phrasesMentioning.all(userId, `%"id":"${imageId}"%`) as Array<{ id: string; data: string }>;
    for (const phrase of phrases) {
      try {
        const vocabs = JSON.parse(phrase.data).vocabs;
        if (Array.isArray(vocabs) && vocabs.some(vocab => vocab?.id === imageId)) owners.add(phrase.id);
      } catch { /* an unparseable row shows no images */ }
    }
  }
  for (const id of owners) touchStmts.bump.run(allocateRevision(), id, userId);
});

/** Store an image for an item or phrase vocab id, together with the revisions that announce it to delta clients. */
export const storeItemImage = writeTransaction((id: string, data: Buffer, mimeType: string, userId: string): ImageStoreResult => {
  const result = storeImageBuffer(id, userId, data, mimeType, Date.now());
  if (result === 'stored') touchItemRevisions([id], userId);
  return result;
});
