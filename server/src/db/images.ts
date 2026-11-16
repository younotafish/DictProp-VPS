import { createHash } from 'crypto';
import { isSupportedImageMime, isValidImage, parseImageDataUri } from '../image-format.js';
import { db, writeTransaction } from './connection.js';

// Image storage: item_images maps an item or phrase vocab id to a blob in image_blobs (see schema.ts).

export const imageStmts = {
  upsertBlob: db.prepare(`INSERT OR IGNORE INTO image_blobs (content_hash, data, byte_length, created_at)
    VALUES (@content_hash, @data, @byte_length, @created_at)`),
  upsert: db.prepare(`
    INSERT INTO item_images (id, user_id, data, updated_at, mime_type, content_hash)
    VALUES (@id, @user_id, @data, @updated_at, @mime_type, @content_hash)
    ON CONFLICT(id) DO UPDATE SET
      user_id = @user_id,
      data = @data,
      updated_at = @updated_at,
      mime_type = @mime_type,
      content_hash = @content_hash
    WHERE item_images.user_id IS NULL OR item_images.user_id = @user_id
  `),
  get: db.prepare(`SELECT COALESCE(b.data, i.data) AS data, i.mime_type, b.content_hash
    FROM item_images i LEFT JOIN image_blobs b ON b.content_hash = i.content_hash
    WHERE i.id = ? AND i.user_id = ?`),
  getMany: db.prepare(`SELECT i.id, COALESCE(b.data, i.data) AS data, i.mime_type
    FROM item_images i LEFT JOIN image_blobs b ON b.content_hash = i.content_hash
    WHERE i.user_id = ? AND i.id IN (SELECT value FROM json_each(?))`),
  // Leaving out a reference whose blob is gone lets a client that still holds the image upload it again.
  manifest: db.prepare(`SELECT i.id FROM item_images i WHERE i.user_id = ? AND (
      i.content_hash IS NULL OR EXISTS (SELECT 1 FROM image_blobs b WHERE b.content_hash = i.content_hash)
    )`),
  // A reference whose blob is gone gets no marker: the client would only fetch an empty image for it.
  versionsForIds: db.prepare(`SELECT i.id, i.content_hash, i.updated_at FROM item_images i
    WHERE i.user_id = ? AND i.id IN (SELECT value FROM json_each(?)) AND (
      i.content_hash IS NULL OR EXISTS (SELECT 1 FROM image_blobs b WHERE b.content_hash = i.content_hash)
    )`),
  owner: db.prepare(`SELECT user_id, content_hash FROM item_images WHERE id = ?`),
  blobExists: db.prepare(`SELECT 1 FROM image_blobs WHERE content_hash = ?`),
  deleteUnreferencedBlob: db.prepare(`DELETE FROM image_blobs
    WHERE content_hash = ? AND NOT EXISTS (
      SELECT 1 FROM item_images WHERE item_images.content_hash = image_blobs.content_hash
    ) AND NOT EXISTS (
      SELECT 1 FROM sentence_enrichments WHERE sentence_enrichments.image_content_hash = image_blobs.content_hash
    )`),
  deleteAllUnreferencedBlobs: db.prepare(`DELETE FROM image_blobs
    WHERE NOT EXISTS (
      SELECT 1 FROM item_images WHERE item_images.content_hash = image_blobs.content_hash
    ) AND NOT EXISTS (
      SELECT 1 FROM sentence_enrichments WHERE sentence_enrichments.image_content_hash = image_blobs.content_hash
    )`),
};

/**
 * Delete the image blobs that no item image and no example-sentence enrichment references: the given
 * hashes, or every blob when none are given. Both reference columns are indexed.
 */
export function deleteUnreferencedBlobs(contentHashes?: Iterable<string | null | undefined>): number {
  if (contentHashes === undefined) return imageStmts.deleteAllUnreferencedBlobs.run().changes;
  let deleted = 0;
  for (const hash of new Set(contentHashes)) {
    if (hash) deleted += imageStmts.deleteUnreferencedBlob.run(hash).changes;
  }
  return deleted;
}

/** What storing an image came to: stored, or refused for bytes that aren't the declared type or an id another user owns. */
export type ImageStoreResult = 'stored' | 'invalid' | 'forbidden';

export function storeImageBuffer(
  id: string,
  userId: string | null,
  data: Buffer,
  mimeType: string,
  updatedAt: number,
): ImageStoreResult {
  if (!isValidImage(data, mimeType)) return 'invalid';
  const owner = imageStmts.owner.get(id) as { user_id: string | null; content_hash: string | null } | undefined;
  if (owner?.user_id && owner.user_id !== userId) return 'forbidden';
  const contentHash = createHash('sha256').update(data).digest('hex');
  imageStmts.upsertBlob.run({
    content_hash: contentHash, data, byte_length: data.length, created_at: updatedAt,
  });
  const reference = imageStmts.upsert.run({
    id, user_id: userId, data: Buffer.alloc(0), updated_at: updatedAt,
    mime_type: mimeType, content_hash: contentHash,
  });
  if (reference.changes > 0 && owner?.content_hash && owner.content_hash !== contentHash) {
    deleteUnreferencedBlobs([owner.content_hash]);
  }
  // The upsert skips a row another user claimed since the owner check above.
  return reference.changes > 0 ? 'stored' : 'forbidden';
}

export function storeImage(id: string, userId: string | null, dataUri: string, updatedAt: number): boolean {
  const parsed = parseImageDataUri(dataUri);
  return parsed ? storeImageBuffer(id, userId, parsed.data, parsed.mimeType, updatedAt) === 'stored' : false;
}

export const upsertItemImageBinary = writeTransaction((id: string, data: Buffer, mimeType: string, userId: string): boolean =>
  storeImageBuffer(id, userId, data, mimeType, Date.now()) === 'stored');

function storedImageToDataUri(row: { data: Buffer | string; mime_type?: string | null } | undefined): string | null {
  // A blob reference whose blob is gone reads back as the row's empty placeholder: that is no image.
  if (!row?.data || row.data.length === 0) return null;
  if (typeof row.data === 'string') return row.data.startsWith('data:image/') ? row.data : null;
  const mime = row.mime_type || 'image/webp';
  return `data:${mime};base64,${row.data.toString('base64')}`;
}

export function linkSentenceEnrichmentImage(
  itemId: string,
  userId: string,
  contentHash: string | null,
  mimeType: string | null,
  updatedAt: number,
): boolean {
  if (!contentHash || !mimeType || imageStmts.owner.get(itemId) || !imageStmts.blobExists.get(contentHash)) {
    return false;
  }
  const reference = imageStmts.upsert.run({
    id: itemId,
    user_id: userId,
    data: Buffer.alloc(0),
    updated_at: updatedAt,
    mime_type: mimeType,
    content_hash: contentHash,
  });
  return reference.changes > 0;
}

/**
 * The image stored for an item or phrase vocab id, as a data URI. Item data itself never holds image bytes: a
 * write moves an inline image into item_images, and July's migration moved the older ones there.
 */
export function getItemImage(id: string, userId: string): string | null {
  const imgRow = imageStmts.get.get(id, userId) as { data: Buffer | string; mime_type: string | null } | undefined;
  return storedImageToDataUri(imgRow);
}

const INLINE_DATA_URI = /^data:(image\/[a-z]+);base64,(.+)$/;

/**
 * An image's bytes for the image endpoint, with their SHA-256 as a version. Blob-backed images already
 * carry that hash; a legacy row's data URI, from before image_blobs, is decoded and hashed here. Raster types only.
 */
export function getItemImageBinary(id: string, userId: string): {
  data: Buffer;
  mimeType: string;
  contentHash: string;
} | null {
  const row = imageStmts.get.get(id, userId) as {
    data: Buffer | string;
    mime_type: string | null;
    content_hash: string | null;
  } | undefined;
  if (row?.content_hash && Buffer.isBuffer(row.data) && row.data.length > 0) {
    const mimeType = row.mime_type || 'image/webp';
    if (!isSupportedImageMime(mimeType)) return null;
    return { data: row.data, mimeType, contentHash: row.content_hash };
  }
  const match = getItemImage(id, userId)?.match(INLINE_DATA_URI);
  if (!match || !isSupportedImageMime(match[1])) return null;
  const data = Buffer.from(match[2], 'base64');
  return { data, mimeType: match[1], contentHash: createHash('sha256').update(data).digest('hex') };
}

/**
 * Get base64 image data URIs for multiple ids in one call.
 * Returns a map of { id: dataUri } for ids that have images.
 */
export function getItemImagesBatch(ids: string[], userId: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (ids.length === 0) return result;

  // Fast path: one indexed query against item_images.
  const rows = imageStmts.getMany.all(userId, JSON.stringify(ids)) as Array<{
    id: string;
    data: Buffer | string;
    mime_type: string | null;
  }>;
  for (const r of rows) {
    const dataUri = storedImageToDataUri(r);
    if (dataUri) result[r.id] = dataUri;
  }
  return result;
}

/** All image ids this user has stored — for the recovery diff (client uploads what's missing). */
export function getImageManifest(userId: string): string[] {
  return (imageStmts.manifest.all(userId) as Array<{ id: string }>).map(r => r.id);
}

/** Whether this id has a stored image whose bytes still exist. */
export function hasItemImage(id: string, userId: string): boolean {
  return imageStmts.versionsForIds.all(userId, JSON.stringify([id])).length > 0;
}
