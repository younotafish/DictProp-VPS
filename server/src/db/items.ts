import { serverImageMarker } from '../shared/image-markers.js';
import { keepServerOwnedData } from '../shared/server-owned-data.js';
import { db } from './connection.js';
import { getItemImagesBatch, imageStmts, linkSentenceEnrichmentImage, storeImage } from './images.js';
import { currentRevision, nextRevision } from './revisions.js';
import { getSentenceEnrichmentForText } from './sentence-enrichments.js';

// ─── Item prepared statements ───

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
};

// Row → StoredItem JSON
export interface ItemRow {
  id: string;
  type: string;
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

// ─── Item CRUD (all scoped by userId) ───

/**
 * Rows → StoredItem JSON without image bytes. An image in item_images (post-migration) or still
 * inline (transition) becomes a marker with a content version, so clients can invalidate an older
 * IndexedDB copy after a replacement. One indexed lookup covers every image on the page.
 */
function rowsToItems(rows: ItemRow[], userId: string) {
  const parsed = rows.map(row => ({ row, data: JSON.parse(row.data) }));
  const imageIds = parsed.flatMap(({ data }) => [
    data.id,
    ...(Array.isArray(data.vocabs) ? data.vocabs.map((vocab: any) => vocab?.id) : []),
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
  const markerFor = (id: unknown, url: unknown): string | null => {
    const version = typeof id === 'string' ? versions.get(id) : undefined;
    if (version) return serverImageMarker(version);
    return typeof url === 'string' && url.startsWith('data:image/') ? serverImageMarker('inline') : null;
  };
  return parsed.map(({ row, data }) => {
    const topMarker = markerFor(data.id, data.imageUrl);
    if (topMarker) data.imageUrl = topMarker;
    if (Array.isArray(data.vocabs)) {
      data.vocabs = data.vocabs.map((vocab: any) => {
        const marker = markerFor(vocab?.id, vocab?.imageUrl);
        return marker ? { ...vocab, imageUrl: marker } : vocab;
      });
    }
    return rowToItem(row, data);
  });
}

export function getAllItems(userId: string) {
  const CHUNK = 500;
  const items: any[] = [];
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
  const add = (t: any) => { if (typeof t === 'string' && t.trim()) texts.add(t.trim()); };
  const stmt = db.prepare(`SELECT data FROM items WHERE is_deleted IS NOT 1`);
  for (const row of stmt.iterate() as Iterable<{ data: string }>) {
    let d: any;
    try { d = JSON.parse(row.data); } catch { continue; }
    if (!d) continue;
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
): { items: any[]; cursor: RevisionCursor; hasMore: boolean; headRevision: number } {
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
    headRevision: (currentRevision.get() as { value: number } | undefined)?.value ?? 0,
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

export function writeItem(item: any, userId: string, options: UpsertOptions): UpsertResult & { enriched: boolean } {
  let data = item.data;
  if (!data || !data.id) throw new Error('Item missing data.id');

  const now = Date.now();
  const existing = stmts.getById.get(data.id) as ItemRow | undefined;
  if (existing?.user_id && existing.user_id !== userId) {
    throw new Error('Item id belongs to another user');
  }

  const incomingUpdatedAt = item.updatedAt || now;
  const existingUpdatedAt = existing?.updated_at || 0;
  const existingRevision = existing?.revision || 0;
  const incomingRevision = typeof item.serverRevision === 'number' ? item.serverRevision : undefined;

  // Content and learning progress have different conflict clocks. An edit can
  // have newer content while carrying SRS loaded before another device reviewed
  // the card, so always select SRS independently by its review timestamp.
  let selectedSrs = item.srs;
  let srsChanged = false;
  if (existing) {
    const existingSrs = JSON.parse(existing.srs);
    const incomingReview = item.srs?.lastReviewDate || 0;
    const existingReview = existingSrs?.lastReviewDate || 0;
    const incomingReviews = item.srs?.totalReviews || 0;
    const existingReviews = existingSrs?.totalReviews || 0;
    if (
      existingReview > incomingReview ||
      (existingReview === incomingReview && existingReviews > incomingReviews)
    ) {
      selectedSrs = existingSrs;
    } else if (incomingReview > existingReview ||
               (incomingReview === existingReview && incomingReviews > existingReviews)) {
      srsChanged = true;
    }

    // A passive listen is deliberately independent from FSRS review progress. Preserve its newest
    // timestamp even when the other device owns the newer explicit review, and mark a newer incoming
    // exposure as an SRS change so stale content cannot suppress its revision.
    const incomingExposure = Number(item.srs?.lastExposureDate) || 0;
    const existingExposure = Number(existingSrs?.lastExposureDate) || 0;
    const latestExposure = Math.max(incomingExposure, existingExposure);
    if ((Number(selectedSrs?.lastExposureDate) || 0) !== latestExposure) {
      selectedSrs = { ...selectedSrs, lastExposureDate: latestExposure };
    }
    if (incomingExposure > existingExposure) srsChanged = true;
  }

  // Ignore stale content while still accepting a newer review selected above.
  const staleContent = !!existing && (incomingRevision !== undefined
    ? incomingRevision < existingRevision
    : incomingUpdatedAt < existingUpdatedAt);

  // A prepared example sentence upgrades itself when it is saved. This lookup is tiny and indexed;
  // the full enrichment pool never enters normal item reads. Preserve any explicit item analysis.
  const enrichment = !staleContent && item.type === 'sentence' && !item.isDeleted &&
    typeof data.text === 'string'
    ? getSentenceEnrichmentForText(data.text)
    : null;
  let enriched = false;
  if (enrichment && !data.analysis) {
    data = {
      ...data,
      analysis: enrichment.analysis,
      analysisGeneratedAt: enrichment.generatedAt,
    };
    enriched = true;
  }

  // After the pool, which returns the sentence it analyses to the saving client. Kept fields aren't returned.
  const beforeKeeping = data;
  if (existing && existing.is_deleted !== 1 && !staleContent && !item.isDeleted && !options.replaceServerFields) {
    data = keepServerOwnedData(data, item.type, JSON.parse(existing.data), existing.type);
  }
  const keptServerFields = data !== beforeKeeping;

  // Capture any incoming base64 into item_images, then strip imageUrl from the data we
  // store — base64 and markers ('idb:stored'/'server:has_image') never live in items.data.
  // For markers / missing / non-base64, we leave item_images untouched (and NEVER delete:
  // a vocab id can be shared with a standalone item). This replaces the old fragile,
  // index-based image-preservation, which could clobber real images with markers.
  let imagesChanged = false;
  const captureImage = (id: string | undefined, url: unknown) => {
    if (id && typeof url === 'string' && url.startsWith('data:image/')) {
      if (storeImage(id, userId, url, now)) imagesChanged = true;
    }
  };

  captureImage(data.id, data.imageUrl);
  if (enrichment && linkSentenceEnrichmentImage(
    data.id,
    userId,
    enrichment.imageContentHash,
    enrichment.imageMimeType,
    now,
  )) {
    imagesChanged = true;
  }
  const { imageUrl: _topImageUrl, ...rest } = data;
  const finalData: any = rest;
  if (Array.isArray(data.vocabs)) {
    finalData.vocabs = data.vocabs.map((v: any) => {
      if (v && typeof v === 'object') {
        captureImage(v.id, v.imageUrl);
        if ('imageUrl' in v) {
          const { imageUrl: _vImageUrl, ...vRest } = v;
          return vRest;
        }
      }
      return v;
    });
  }

  const row = {
    id: data.id,
    type: staleContent ? existing.type : item.type,
    data: staleContent ? existing.data : JSON.stringify(finalData),
    srs: JSON.stringify(selectedSrs),
    saved_at: staleContent ? existing.saved_at : (item.savedAt || now),
    updated_at: staleContent && !srsChanged ? existingUpdatedAt : Math.max(existingUpdatedAt, incomingUpdatedAt),
    is_deleted: staleContent ? existing.is_deleted : (item.isDeleted ? 1 : 0),
    is_archived: staleContent ? existing.is_archived : (item.isArchived ? 1 : 0),
    user_id: userId,
    project: null,
  };
  // A copy that differs from the row only by lacking kept fields changes nothing. Its client keeps its own
  // data at an unchanged revision and pushes that copy again, so a revision per push would never settle.
  if (existing && keptServerFields && !imagesChanged && !enriched &&
      (Object.keys(row) as Array<keyof typeof row>).every(key => row[key] === existing[key])) {
    return { revision: existingRevision, conflicted: false, enriched: false };
  }
  const revision = staleContent && !srsChanged
    ? existingRevision
    : ((nextRevision.get() as { value: number }).value);
  stmts.upsert.run({ ...row, revision });
  return { revision, conflicted: staleContent, enriched };
}

// The item row, its captured images and its revision commit together.
const writeItemTransaction = db.transaction(writeItem);

export function upsertItem(item: any, userId: string, options: UpsertOptions = {}): UpsertResult {
  const { revision, conflicted } = writeItemTransaction(item, userId, options);
  return { revision, conflicted };
}

/** `enriched` lists the sentences the example-enrichment pool just gave an analysis. */
export const upsertMany = db.transaction((items: any[], userId: string, options: UpsertOptions = {}): {
  revisions: Record<string, number>;
  conflicts: string[];
  enriched: string[];
} => {
  const revisions: Record<string, number> = {};
  const conflicts: string[] = [];
  const enriched: string[] = [];
  for (const item of items) {
    const result = writeItem(item, userId, options);
    if (result.conflicted) conflicts.push(item.data.id);
    else revisions[item.data.id] = result.revision;
    if (result.enriched) enriched.push(item.data.id);
  }
  return { revisions, conflicts, enriched };
});

export function softDeleteItem(id: string, userId: string): boolean {
  // Deleting an id the user doesn't have changes nothing, so it must not advance the revision clock.
  if (!stmts.existsScoped.get(id, userId)) return false;
  const revision = (nextRevision.get() as { value: number }).value;
  stmts.softDelete.run(Date.now(), revision, id, userId);
  return true;
}

export function getItemById(id: string, userId: string, includeImages = true) {
  const row = stmts.getByIdScoped.get(id, userId) as ItemRow | undefined;
  if (!row) return null;
  if (!includeImages) return rowsToItems([row], userId)[0];
  const item = rowToItem(row);
  // Re-inject base64 from item_images for this single item.
  const d = item.data as any;
  const ids = [d.id, ...(Array.isArray(d.vocabs) ? d.vocabs.map((v: any) => v.id) : [])].filter(Boolean);
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
export const touchItemRevisions = db.transaction((imageIds: readonly string[], userId: string): void => {
  const owners = new Set<string>();
  for (const imageId of new Set(imageIds)) {
    if (stmts.existsScoped.get(imageId, userId)) owners.add(imageId);
    const phrases = touchStmts.phrasesMentioning.all(userId, `%"id":"${imageId}"%`) as Array<{ id: string; data: string }>;
    for (const phrase of phrases) {
      try {
        const vocabs = JSON.parse(phrase.data).vocabs;
        if (Array.isArray(vocabs) && vocabs.some((vocab: any) => vocab?.id === imageId)) owners.add(phrase.id);
      } catch { /* an unparseable row shows no images */ }
    }
  }
  for (const id of owners) touchStmts.bump.run((nextRevision.get() as { value: number }).value, id, userId);
});
