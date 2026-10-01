import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { randomUUID, createHash } from 'crypto';
import { env } from './env.js';
import { hasImageSignature } from './image-format.js';
import { advanceReviewSrs } from './srs.js';
import { sentenceLookupHash, type SentenceEnrichmentEntry } from './sentence-enrichment.js';
import { hasCompleteSentenceAnalysis } from './sentence-analysis.js';

// Ensure data directory exists
mkdirSync(env.DATA_DIR, { recursive: true });

const dbPath = resolve(env.DATA_DIR, 'dictprop.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
// In WAL mode NORMAL can lose only the last commits on power loss, never corrupt the file. Importers
// write this file while the server runs, so a writer waits out the other's transaction instead of
// failing, and a checkpointed WAL shrinks back instead of keeping its largest size on the small disk.
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 10000');
db.pragma('journal_size_limit = 67108864');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('vocab', 'phrase', 'sentence')),
    data TEXT NOT NULL,
    srs TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    updated_at INTEGER,
    is_deleted INTEGER DEFAULT 0,
    is_archived INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
  CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    photo_url TEXT,
    is_approved INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('item_revision', 0);

  CREATE TABLE IF NOT EXISTS review_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_type TEXT NOT NULL CHECK(item_type IN ('vocab', 'phrase', 'sentence')),
    reviewed_at INTEGER NOT NULL,
    previous_step INTEGER NOT NULL,
    next_step INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_events_user_time ON review_events(user_id, reviewed_at);
`);

// Migration: add user_id column to items if missing
const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
if (!columns.some(c => c.name === 'user_id')) {
  db.exec(`ALTER TABLE items ADD COLUMN user_id TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_user_id ON items(user_id)`);
}
if (!columns.some(c => c.name === 'revision')) {
  db.exec(`ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_items_user_revision ON items(user_id, revision, id)`);
// Phrase scans (image owners, the inline-image fallback) read the user's phrase rows, not the library.
db.exec(`CREATE INDEX IF NOT EXISTS idx_items_user_type ON items(user_id, type)`);

const reviewColumns = db.prepare(`PRAGMA table_info(review_events)`).all() as { name: string }[];
if (!reviewColumns.some(column => column.name === 'rating')) {
  db.exec(`ALTER TABLE review_events ADD COLUMN rating TEXT NOT NULL DEFAULT 'good'`);
}
if (!reviewColumns.some(column => column.name === 'task_type')) {
  db.exec(`ALTER TABLE review_events ADD COLUMN task_type TEXT`);
}
if (!reviewColumns.some(column => column.name === 'duration_ms')) {
  db.exec(`ALTER TABLE review_events ADD COLUMN duration_ms INTEGER`);
}
if (!reviewColumns.some(column => column.name === 'session_id')) {
  db.exec(`ALTER TABLE review_events ADD COLUMN session_id TEXT`);
}
if (!reviewColumns.some(column => column.name === 'undone_at')) {
  db.exec(`ALTER TABLE review_events ADD COLUMN undone_at INTEGER`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS review_event_items (
    event_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    previous_srs TEXT NOT NULL,
    applied_srs TEXT NOT NULL,
    PRIMARY KEY (event_id, item_id)
  );
  DROP INDEX IF EXISTS idx_review_event_items_event;
`);
// The item's revisions before and after the review, so a client can tell whether anything besides the
// review changed the item since its own copy. Rows stored before these columns have neither.
const reviewItemColumns = db.prepare(`PRAGMA table_info(review_event_items)`).all() as { name: string }[];
if (!reviewItemColumns.some(column => column.name === 'base_revision')) {
  db.exec(`ALTER TABLE review_event_items ADD COLUMN base_revision INTEGER`);
}
if (!reviewItemColumns.some(column => column.name === 'applied_revision')) {
  db.exec(`ALTER TABLE review_event_items ADD COLUMN applied_revision INTEGER`);
}

// Migration: add project column to items if missing
try {
  if (!columns.some(c => c.name === 'project')) {
    db.exec(`ALTER TABLE items ADD COLUMN project TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_project ON items(project)`);
} catch (e) {
  console.warn('Project column migration:', e);
}

// Projects table
try {
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
} catch (e) {
  console.warn('Projects table creation:', e);
}

/**
 * Remove retired project metadata without delaying the HTTP listener. Updating this SQLite table can
 * rewrite large pages on the small VPS, so a single startup UPDATE exceeds the deploy health window.
 * Small transactions yield between batches; reads already omit project and writes force it to NULL.
 */
export async function migrateLegacyProjects(): Promise<void> {
  const batchSize = 50;
  const selectBatch = db.prepare(`
    SELECT rowid AS rid FROM items
    WHERE project IS NOT NULL AND rowid > ?
    ORDER BY rowid LIMIT ${batchSize}
  `);
  const clearProject = db.prepare('UPDATE items SET project = NULL WHERE rowid = ?');
  const clearBatch = db.transaction((rows: Array<{ rid: number }>) => {
    for (const row of rows) clearProject.run(row.rid);
  });
  let lastRowId = 0;
  let cleared = 0;
  for (;;) {
    const rows = selectBatch.all(lastRowId) as Array<{ rid: number }>;
    if (rows.length === 0) break;
    clearBatch(rows);
    cleared += rows.length;
    lastRowId = rows[rows.length - 1].rid;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  db.prepare('DELETE FROM projects').run();
  if (cleared > 0) console.log(`[migrate] cleared ${cleared} legacy project tags`);
}

// Image storage: base64 data URIs live here, OUT of items.data, so item reads/writes
// never touch image bytes. Keyed by id — a SHARED keyspace for both top-level item ids
// and nested phrase-vocab ids (a vocab id can appear as both; see DetailView "save vocab").
// user_id mirrors items.user_id (nullable for legacy orphan rows, claimed on first signup).
try {
  db.exec(`CREATE TABLE IF NOT EXISTS item_images (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    data TEXT NOT NULL,
    updated_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_item_images_user_id ON item_images(user_id)`);
  const imageColumns = db.prepare(`PRAGMA table_info(item_images)`).all() as { name: string }[];
  if (!imageColumns.some(c => c.name === 'mime_type')) db.exec(`ALTER TABLE item_images ADD COLUMN mime_type TEXT`);
  if (!imageColumns.some(c => c.name === 'content_hash')) db.exec(`ALTER TABLE item_images ADD COLUMN content_hash TEXT`);
  // Cover stripped-item image markers without fetching legacy rows whose data column can still
  // contain a large base64 payload. This keeps the first sync after a restart from blocking Node.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_item_images_user_versions
    ON item_images(user_id, id, content_hash, updated_at)`);
  // Blob cleanup asks whether anything still references a hash; without this it scans every image.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_item_images_content_hash ON item_images(content_hash)`);
  db.exec(`CREATE TABLE IF NOT EXISTS image_blobs (
    content_hash TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
} catch (e) {
  console.warn('item_images table creation:', e);
}

// Prepared example-sentence enrichment is global source material, not a user item. Keeping it in a
// separate lookup table prevents tens of thousands of analyses and images from entering /api/items.
// Images reuse image_blobs and are linked into a user's item_images row only when that sentence is saved.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS sentence_enrichments (
    lookup_hash TEXT PRIMARY KEY,
    source_id TEXT UNIQUE NOT NULL,
    text_hash TEXT NOT NULL,
    source_text TEXT NOT NULL,
    analysis TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    image_content_hash TEXT,
    image_mime_type TEXT,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sentence_enrichments_source_id
    ON sentence_enrichments(source_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sentence_enrichments_image
    ON sentence_enrichments(image_content_hash) WHERE image_content_hash IS NOT NULL`);
} catch (e) {
  console.warn('sentence_enrichments table creation:', e);
}

// Word comparisons: AI-generated side-by-side analyses, kept OUT of the items table (its CHECK
// constraint only allows vocab/phrase/sentence). Keyed by the normalized word-set (e.g. 'fable|parable')
// so direction doesn't matter and each pair stores once; surfaced on every involved word's page.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS comparisons (
    key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    words TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comparisons_user_id ON comparisons(user_id)`);
} catch (e) {
  console.warn('comparisons table creation:', e);
}

// Refresh planner statistics for tables whose indexes changed, bounded so it stays quick on a large file.
db.pragma('optimize = 0x10002');

// ─── Item prepared statements ───

const stmts = {
  getAll: db.prepare(`SELECT * FROM items WHERE user_id = ?`),
  getAllChunk: db.prepare(`SELECT rowid AS _rowid, * FROM items WHERE user_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`),
  getSince: db.prepare(`SELECT * FROM items WHERE user_id = ? AND (updated_at > ? OR (updated_at IS NULL AND saved_at > ?))`),
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
  assignOrphanItems: db.prepare(`UPDATE items SET user_id = ? WHERE user_id IS NULL`),
  getDataForIds: db.prepare(`SELECT id, data FROM items WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`),
  phrasesWithInlineImages: db.prepare(`SELECT data FROM items
    WHERE user_id = ? AND type = 'phrase' AND data LIKE '%data:image/%'`),
  updateSrs: db.prepare(`UPDATE items SET srs = ?, updated_at = ?, revision = ? WHERE id = ? AND user_id = ?`),
};

// ─── Comparison prepared statements + accessors ───

const compStmts = {
  getAll: db.prepare(`SELECT key, words, data, updated_at FROM comparisons WHERE user_id = ?`),
  upsert: db.prepare(`
    INSERT INTO comparisons (key, user_id, words, data, updated_at)
    VALUES (@key, @user_id, @words, @data, @updated_at)
    ON CONFLICT(key, user_id) DO UPDATE SET words = @words, data = @data, updated_at = @updated_at
    WHERE excluded.updated_at >= comparisons.updated_at
  `),
};

export interface StoredComparisonRow { key: string; words: string[]; data: any; updatedAt: number }

export function getComparisons(userId: string): StoredComparisonRow[] {
  const rows = compStmts.getAll.all(userId) as any[];
  return rows.map((r) => ({
    key: r.key,
    words: JSON.parse(r.words),
    data: JSON.parse(r.data),
    updatedAt: r.updated_at,
  }));
}

/** Returns false when the stored comparison is newer, so a device replaying an old copy can't regress it. */
export function upsertComparison(userId: string, key: string, words: string[], data: any, updatedAt: number): boolean {
  return compStmts.upsert.run({
    key,
    user_id: userId,
    words: JSON.stringify(words),
    data: JSON.stringify(data),
    updated_at: updatedAt,
  }).changes > 0;
}

// ─── Image (item_images) prepared statements ───

const imageStmts = {
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
  assignOrphan: db.prepare(`UPDATE item_images SET user_id = ? WHERE user_id IS NULL`),
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

const sentenceEnrichmentStmts = {
  get: db.prepare(`SELECT * FROM sentence_enrichments WHERE lookup_hash = ?`),
  hasImage: db.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM sentence_enrichments e
      JOIN image_blobs b ON b.content_hash = e.image_content_hash
      WHERE e.lookup_hash = ? AND b.byte_length > 0
    ) AS has_image
  `),
  getImage: db.prepare(`
    SELECT b.data, e.image_mime_type
    FROM sentence_enrichments e
    JOIN image_blobs b ON b.content_hash = e.image_content_hash
    WHERE e.lookup_hash = ?
  `),
  count: db.prepare(`SELECT COUNT(*) AS count FROM sentence_enrichments`),
  attachImage: db.prepare(`
    UPDATE sentence_enrichments
    SET image_content_hash = @image_content_hash,
        image_mime_type = @image_mime_type,
        updated_at = @updated_at
    WHERE lookup_hash = @lookup_hash
  `),
  upsert: db.prepare(`
    INSERT INTO sentence_enrichments (
      lookup_hash, source_id, text_hash, source_text, analysis, generated_at,
      image_content_hash, image_mime_type, updated_at
    ) VALUES (
      @lookup_hash, @source_id, @text_hash, @source_text, @analysis, @generated_at,
      @image_content_hash, @image_mime_type, @updated_at
    )
    ON CONFLICT(lookup_hash) DO UPDATE SET
      source_id = excluded.source_id,
      text_hash = excluded.text_hash,
      source_text = excluded.source_text,
      analysis = excluded.analysis,
      generated_at = excluded.generated_at,
      image_content_hash = COALESCE(excluded.image_content_hash, sentence_enrichments.image_content_hash),
      image_mime_type = COALESCE(excluded.image_mime_type, sentence_enrichments.image_mime_type),
      updated_at = excluded.updated_at
    WHERE excluded.generated_at >= sentence_enrichments.generated_at
  `),
};
function parseImageDataUri(dataUri: string): { data: Buffer; mimeType: string } | null {
  const match = dataUri.match(/^data:(image\/(?:avif|gif|jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: Buffer.from(match[2], 'base64') };
}

function storeImageBuffer(id: string, userId: string | null, data: Buffer, mimeType: string, updatedAt: number): boolean {
  if (data.length === 0 || !/^image\/(?:avif|gif|jpeg|png|webp)$/.test(mimeType) ||
      !hasImageSignature(data, mimeType)) return false;
  const owner = imageStmts.owner.get(id) as { user_id: string | null; content_hash: string | null } | undefined;
  if (owner?.user_id && owner.user_id !== userId) return false;
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
  return reference.changes > 0;
}

function storeImage(id: string, userId: string | null, dataUri: string, updatedAt: number): boolean {
  const parsed = parseImageDataUri(dataUri);
  return parsed ? storeImageBuffer(id, userId, parsed.data, parsed.mimeType, updatedAt) : false;
}

export function upsertItemImageBinary(id: string, data: Buffer, mimeType: string, userId: string): boolean {
  return storeImageBuffer(id, userId, data, mimeType, Date.now());
}

function storedImageToDataUri(row: { data: Buffer | string; mime_type?: string | null } | undefined): string | null {
  // A blob reference whose blob is gone reads back as the row's empty placeholder: that is no image.
  if (!row?.data || row.data.length === 0) return null;
  if (typeof row.data === 'string') return row.data.startsWith('data:image/') ? row.data : null;
  const mime = row.mime_type || 'image/webp';
  return `data:${mime};base64,${row.data.toString('base64')}`;
}

interface SentenceEnrichmentRow {
  lookup_hash: string;
  source_id: string;
  text_hash: string;
  source_text: string;
  analysis: string;
  generated_at: number;
  image_content_hash: string | null;
  image_mime_type: string | null;
  updated_at: number;
}

export interface SentenceEnrichmentImportRecord {
  entry: SentenceEnrichmentEntry;
  image?: Buffer;
  mimeType?: string;
}

export interface SentenceEnrichmentImportResult {
  status: 'inserted' | 'updated' | 'unchanged' | 'stale';
  imageStored: boolean;
}

export function getSentenceEnrichmentCount(): number {
  return (sentenceEnrichmentStmts.count.get() as { count: number }).count;
}

export function getSentenceEnrichmentForText(text: string): {
  analysis: any;
  generatedAt: number;
  imageContentHash: string | null;
  imageMimeType: string | null;
} | null {
  if (!text.trim()) return null;
  const row = sentenceEnrichmentStmts.get.get(sentenceLookupHash(text)) as SentenceEnrichmentRow | undefined;
  if (!row) return null;
  try {
    return {
      analysis: JSON.parse(row.analysis),
      generatedAt: row.generated_at,
      imageContentHash: row.image_content_hash,
      imageMimeType: row.image_mime_type,
    };
  } catch {
    return null;
  }
}

export function getSentenceEnrichmentImage(lookupHash: string): {
  data: Buffer;
  mimeType: string;
} | null {
  if (!/^[a-f0-9]{64}$/.test(lookupHash)) return null;
  const row = sentenceEnrichmentStmts.getImage.get(lookupHash) as {
    data: Buffer;
    image_mime_type: string;
  } | undefined;
  if (!row?.data || !/^image\/(?:avif|gif|jpeg|png|webp)$/.test(row.image_mime_type || '')) return null;
  return { data: row.data, mimeType: row.image_mime_type };
}

export function upsertSentenceEnrichment(record: SentenceEnrichmentImportRecord): SentenceEnrichmentImportResult {
  const { entry, image, mimeType } = record;
  const existing = sentenceEnrichmentStmts.get.get(entry.lookupHash) as SentenceEnrichmentRow | undefined;
  const existingHasImage = existing
    ? (sentenceEnrichmentStmts.hasImage.get(entry.lookupHash) as { has_image: number }).has_image === 1
    : false;
  let existingAnalysisComplete = false;
  if (existing) {
    try {
      existingAnalysisComplete = hasCompleteSentenceAnalysis(JSON.parse(existing.analysis));
    } catch {
      existingAnalysisComplete = false;
    }
  }
  const preserveExistingAnalysis = existingAnalysisComplete && !hasCompleteSentenceAnalysis(entry.analysis);
  const attachImageWithoutAnalysis = !!existing && !!image && !!mimeType && !existingHasImage &&
    (existing.generated_at > entry.generatedAt || preserveExistingAnalysis);
  if (existing && (existing.generated_at > entry.generatedAt || preserveExistingAnalysis) &&
      !attachImageWithoutAnalysis) {
    return { status: 'stale', imageStored: false };
  }

  let imageContentHash: string | null = existing?.image_content_hash ?? null;
  let imageMimeType: string | null = existing?.image_mime_type ?? null;
  let imageStored = false;
  if (image && mimeType) {
    if (image.length === 0 || !/^image\/(?:avif|gif|jpeg|png|webp)$/.test(mimeType) ||
        !hasImageSignature(image, mimeType)) {
      throw new Error(`Sentence enrichment ${entry.id} has an invalid image`);
    }
    imageContentHash = createHash('sha256').update(image).digest('hex');
    imageMimeType = mimeType;
    const inserted = imageStmts.upsertBlob.run({
      content_hash: imageContentHash,
      data: image,
      byte_length: image.length,
      created_at: entry.generatedAt,
    });
    imageStored = inserted.changes > 0;
  }

  // Media and analysis can finish in separate resumable waves. A verified late image may repair a
  // newer analysis row, but must never replace that row's text, analysis, or generation timestamp.
  if (attachImageWithoutAnalysis) {
    sentenceEnrichmentStmts.attachImage.run({
      lookup_hash: entry.lookupHash,
      image_content_hash: imageContentHash,
      image_mime_type: imageMimeType,
      updated_at: Date.now(),
    });
    if (existing.image_content_hash && existing.image_content_hash !== imageContentHash) {
      deleteUnreferencedBlobs([existing.image_content_hash]);
    }
    return { status: 'updated', imageStored };
  }

  const analysis = JSON.stringify(entry.analysis);
  const unchanged = !!existing && existing.source_id === entry.id && existing.text_hash === entry.textHash &&
    existing.source_text === entry.text && existing.analysis === analysis &&
    existing.generated_at === entry.generatedAt && existing.image_content_hash === imageContentHash &&
    existing.image_mime_type === imageMimeType;
  if (unchanged) return { status: 'unchanged', imageStored };

  sentenceEnrichmentStmts.upsert.run({
    lookup_hash: entry.lookupHash,
    source_id: entry.id,
    text_hash: entry.textHash,
    source_text: entry.text,
    analysis,
    generated_at: entry.generatedAt,
    image_content_hash: imageContentHash,
    image_mime_type: imageMimeType,
    updated_at: Date.now(),
  });
  if (existing?.image_content_hash && existing.image_content_hash !== imageContentHash) {
    deleteUnreferencedBlobs([existing.image_content_hash]);
  }
  return { status: existing ? 'updated' : 'inserted', imageStored };
}

function linkSentenceEnrichmentImage(
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

// ─── User / Session prepared statements ───

const userStmts = {
  findByGoogleId: db.prepare(`SELECT * FROM users WHERE google_id = ?`),
  create: db.prepare(`
    INSERT INTO users (id, google_id, email, display_name, photo_url, is_approved, is_admin, created_at)
    VALUES (@id, @google_id, @email, @display_name, @photo_url, @is_approved, @is_admin, @created_at)
  `),
  count: db.prepare(`SELECT COUNT(*) as cnt FROM users`),
  listAll: db.prepare(`SELECT * FROM users ORDER BY created_at`),
};

const sessionStmts = {
  create: db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (@token, @user_id, @created_at, @expires_at)`),
  getUser: db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `),
  delete: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  deleteExpired: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
};

// Row → StoredItem JSON
interface ItemRow {
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

export interface UserRow {
  id: string;
  google_id: string;
  email: string;
  display_name: string | null;
  photo_url: string | null;
  is_approved: number;
  is_admin: number;
  created_at: number;
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
    if (version) return `server:has_image:${version}`;
    return typeof url === 'string' && url.startsWith('data:image/') ? 'server:has_image:inline' : null;
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

export function getItemsSince(since: number, userId: string) {
  return rowsToItems(stmts.getSince.all(userId, since, since) as ItemRow[], userId);
}

export interface RevisionCursor {
  revision: number;
  id: string;
}

const currentRevision = db.prepare(`SELECT value FROM sync_meta WHERE key = 'item_revision'`);

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

const nextRevision = db.prepare(`UPDATE sync_meta SET value = value + 1 WHERE key = 'item_revision' RETURNING value`);

export interface UpsertResult { revision: number; conflicted: boolean }

export interface UpsertOptions {
  /**
   * The write is the whole item, so a server-owned field it omits is removed instead of kept from the
   * stored row. Only the corpus-audit import writes items this way: its data must match audited hashes.
   */
  replaceServerFields?: boolean;
}

// Only server-side jobs write these. A client or importer can write from a copy made before a job ran.
const SERVER_OWNED_FIELDS = ['usageAudit', 'advancedEnrichment', 'localImageEnrichment'] as const;

function withServerOwnedFields(target: any, stored: any): any {
  if (!stored || typeof stored !== 'object') return target;
  let result = target;
  for (const field of SERVER_OWNED_FIELDS) {
    if (result[field] === undefined && stored[field] !== undefined) {
      if (result === target) result = { ...target };
      result[field] = stored[field];
    }
  }
  return result;
}

/**
 * Keep the server-owned fields a current write omits: the item's own, each phrase vocab's by id, and a
 * sentence's analysis while its text is unchanged (an analysis of other text would be wrong).
 */
function keepServerOwnedData(data: any, type: string, stored: any, storedType: string): any {
  if (type !== storedType || !stored || typeof stored !== 'object') return data;
  let result = withServerOwnedFields(data, stored);
  if (type === 'sentence' && result.analysis === undefined && stored.analysis !== undefined &&
      result.text === stored.text) {
    result = { ...result, analysis: stored.analysis, analysisGeneratedAt: stored.analysisGeneratedAt };
  }
  if (type === 'phrase' && Array.isArray(result.vocabs) && Array.isArray(stored.vocabs)) {
    const storedVocabs = new Map<string, any>();
    for (const vocab of stored.vocabs) if (typeof vocab?.id === 'string') storedVocabs.set(vocab.id, vocab);
    let changed = false;
    const vocabs = result.vocabs.map((vocab: any) => {
      if (!vocab || typeof vocab !== 'object' || typeof vocab.id !== 'string') return vocab;
      const kept = withServerOwnedFields(vocab, storedVocabs.get(vocab.id));
      if (kept !== vocab) changed = true;
      return kept;
    });
    if (changed) result = { ...result, vocabs };
  }
  return result;
}

function writeItem(item: any, userId: string, options: UpsertOptions): UpsertResult & { enriched: boolean } {
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

export interface ReviewEventRow {
  id: string;
  itemId: string;
  itemType: 'vocab' | 'phrase' | 'sentence';
  reviewedAt: number;
  previousStep: number;
  nextStep: number;
  rating?: 'again' | 'hard' | 'good' | 'easy';
  taskType?: 'meaning' | 'production' | 'cloze' | 'listening' | 'quick';
  durationMs?: number;
  sessionId?: string;
}

const reviewStmts = {
  insert: db.prepare(`INSERT OR IGNORE INTO review_events
    (id, user_id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id)
    VALUES (@id, @user_id, @item_id, @item_type, @reviewed_at, @previous_step, @next_step, @rating, @task_type, @duration_ms, @session_id)`),
  recent: db.prepare(`SELECT id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id
    FROM review_events WHERE user_id = ? AND reviewed_at >= ? AND undone_at IS NULL ORDER BY reviewed_at`),
  timesBetween: db.prepare(`SELECT reviewed_at FROM review_events
    WHERE user_id = ? AND reviewed_at >= ? AND reviewed_at < ? AND undone_at IS NULL ORDER BY reviewed_at`).pluck(),
  countBefore: db.prepare(`SELECT COUNT(*) FROM review_events
    WHERE user_id = ? AND reviewed_at < ? AND undone_at IS NULL`).pluck(),
  byId: db.prepare(`SELECT id, user_id, item_id, item_type, reviewed_at, previous_step, next_step, rating, task_type, duration_ms, session_id, undone_at
    FROM review_events WHERE id = ?`),
  insertItemSnapshot: db.prepare(`INSERT INTO review_event_items (event_id, item_id, previous_srs, applied_srs, base_revision, applied_revision)
    VALUES (?, ?, ?, ?, ?, ?)`),
  snapshotsByEvent: db.prepare(`SELECT item_id, previous_srs, applied_srs, base_revision, applied_revision
    FROM review_event_items WHERE event_id = ? ORDER BY item_id`),
  markUndone: db.prepare(`UPDATE review_events SET undone_at = ? WHERE id = ? AND user_id = ? AND undone_at IS NULL`),
};

export function addReviewEvent(event: ReviewEventRow, userId: string): void {
  reviewStmts.insert.run({
    id: event.id, user_id: userId, item_id: event.itemId, item_type: event.itemType,
    reviewed_at: event.reviewedAt, previous_step: event.previousStep, next_step: event.nextStep,
    rating: event.rating || 'good', task_type: event.taskType || null,
    duration_ms: event.durationMs ?? null, session_id: event.sessionId || null,
  });
}

export function getReviewEvents(userId: string, since: number): ReviewEventRow[] {
  return (reviewStmts.recent.all(userId, since) as any[]).map(row => ({
    id: row.id, itemId: row.item_id, itemType: row.item_type, reviewedAt: row.reviewed_at,
    previousStep: row.previous_step, nextStep: row.next_step,
    rating: row.rating || 'good',
    ...(row.task_type ? { taskType: row.task_type } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
  }));
}

/** A year and a day: as far back as the study dashboard's streak can reach. */
const REVIEW_TIMES_REACH = 366 * 24 * 60 * 60 * 1000;

export interface ReviewHistoryRows {
  recent: ReviewEventRow[];
  olderTimes: number[];
  olderCount: number;
}

/**
 * The review history the study dashboard needs: every review since `recentSince` in full, and for older
 * ones only when they happened (the year before, all a streak can use) and how many there are. The full
 * history runs to tens of thousands of reviews, too much to download on every launch.
 */
export function getReviewHistory(userId: string, recentSince: number): ReviewHistoryRows {
  return {
    recent: getReviewEvents(userId, recentSince),
    olderTimes: reviewStmts.timesBetween.all(userId, recentSince - REVIEW_TIMES_REACH, recentSince) as number[],
    olderCount: reviewStmts.countBefore.get(userId, recentSince) as number,
  };
}

export interface AppliedReviewResult {
  applied: boolean;
  event: ReviewEventRow;
  items: any[];
  /**
   * Each item's revision before the review, for items the review was the last change to. A client whose
   * copy has that revision knows the server changed nothing else, so its unsynced edits still apply.
   */
  baseRevisions: Record<string, number>;
}

interface ReviewSnapshotRow {
  item_id: string;
  previous_srs: string;
  applied_srs: string;
  base_revision: number | null;
  applied_revision: number | null;
}

const applyReviewTransaction = db.transaction((
  incoming: ReviewEventRow,
  itemIds: string[],
  userId: string,
  seedItem: unknown,
): { applied: boolean; event: ReviewEventRow; itemIds: string[]; baseRevisions: Record<string, number> } | null => {
  let seededRevision: number | undefined;
  if (seedItem !== undefined && !stmts.getByIdScoped.get(incoming.itemId, userId)) {
    seededRevision = writeItem(seedItem, userId, {}).revision;
  }
  const previous = reviewStmts.byId.get(incoming.id) as any;
  if (previous) {
    if (previous.user_id !== userId) throw new Error('Review event id belongs to another user');
    const snapshots = reviewStmts.snapshotsByEvent.all(incoming.id) as ReviewSnapshotRow[];
    const storedIds = snapshots.map(row => row.item_id);
    // A retried review reports a base only while the review is still the item's latest change.
    const baseRevisions: Record<string, number> = {};
    if (previous.undone_at === null) {
      for (const snapshot of snapshots) {
        if (snapshot.base_revision === null || snapshot.applied_revision === null) continue;
        const row = stmts.getByIdScoped.get(snapshot.item_id, userId) as ItemRow | undefined;
        if (row?.revision === snapshot.applied_revision) baseRevisions[snapshot.item_id] = snapshot.base_revision;
      }
    }
    return {
      applied: false,
      event: {
        id: previous.id,
        itemId: previous.item_id,
        itemType: previous.item_type,
        reviewedAt: previous.reviewed_at,
        previousStep: previous.previous_step,
        nextStep: previous.next_step,
        rating: previous.rating || 'good',
        taskType: previous.task_type || undefined,
        durationMs: previous.duration_ms ?? undefined,
        sessionId: previous.session_id || undefined,
      },
      itemIds: storedIds.length > 0 ? storedIds : itemIds,
      baseRevisions,
    };
  }

  const rows = itemIds
    .map(id => stmts.getByIdScoped.get(id, userId) as ItemRow | undefined)
    .filter((row): row is ItemRow => !!row && row.is_deleted !== 1);
  const target = rows.find(row => row.id === incoming.itemId);
  if (!target) return null;

  const canonical = rows.reduce((best, row) => {
    const bestSrs = JSON.parse(best.srs);
    const rowSrs = JSON.parse(row.srs);
    const bestReview = Number(bestSrs.lastReviewDate) || 0;
    const rowReview = Number(rowSrs.lastReviewDate) || 0;
    if (rowReview !== bestReview) return rowReview > bestReview ? row : best;
    return (Number(rowSrs.totalReviews) || 0) > (Number(bestSrs.totalReviews) || 0) ? row : best;
  }, target);
  const baseSrs = JSON.parse(canonical.srs);
  const serverNow = Date.now();
  const reviewedAt = Math.max(
    Number(baseSrs.lastReviewDate) || 0,
    Math.min(incoming.reviewedAt, serverNow + 5 * 60 * 1000),
  );
  const rating = incoming.rating || 'good';
  const nextSrs = advanceReviewSrs(baseSrs, reviewedAt, rating);
  const event: ReviewEventRow = {
    id: incoming.id,
    itemId: target.id,
    itemType: target.type as ReviewEventRow['itemType'],
    reviewedAt,
    previousStep: Number(baseSrs.totalReviews) || 0,
    nextStep: Number(nextSrs.totalReviews) || 0,
    rating,
    taskType: incoming.taskType,
    durationMs: incoming.durationMs,
    sessionId: incoming.sessionId,
  };
  const inserted = reviewStmts.insert.run({
    id: event.id,
    user_id: userId,
    item_id: event.itemId,
    item_type: event.itemType,
    reviewed_at: event.reviewedAt,
    previous_step: event.previousStep,
    next_step: event.nextStep,
    rating: event.rating,
    task_type: event.taskType || null,
    duration_ms: event.durationMs ?? null,
    session_id: event.sessionId || null,
  });
  if (inserted.changes !== 1) throw new Error('Review event could not be stored');

  const baseRevisions: Record<string, number> = {};
  for (const row of rows) {
    const revision = (nextRevision.get() as { value: number }).value;
    const siblingSrs = { ...nextSrs, id: row.id, type: row.type };
    const appliedSrs = JSON.stringify(siblingSrs);
    // A seed is the reviewing client's own copy, so the server held nothing that client hasn't seen: its base
    // is the "no revision yet" the client itself holds.
    const baseRevision = row.id === incoming.itemId && row.revision === seededRevision ? 0 : row.revision;
    reviewStmts.insertItemSnapshot.run(event.id, row.id, row.srs, appliedSrs, baseRevision, revision);
    stmts.updateSrs.run(appliedSrs, serverNow, revision, row.id, userId);
    baseRevisions[row.id] = baseRevision;
  }
  return { applied: true, event, itemIds: rows.map(row => row.id), baseRevisions };
});

/**
 * `seedItem` is the reviewing client's copy of the reviewed item, stored only when the server holds no item
 * with that id. It commits in the review's transaction, so a failed review leaves no seed behind.
 */
export function applyReviewEvent(
  event: ReviewEventRow,
  itemIds: string[],
  userId: string,
  seedItem?: unknown,
): AppliedReviewResult | null {
  const uniqueIds = Array.from(new Set([event.itemId, ...itemIds])).slice(0, 100);
  const result = applyReviewTransaction(event, uniqueIds, userId, seedItem);
  if (!result) return null;
  return {
    applied: result.applied,
    event: result.event,
    items: result.itemIds.map(id => getItemById(id, userId, false)).filter(Boolean),
    baseRevisions: result.baseRevisions,
  };
}

export interface UndoneReviewResult {
  undone: boolean;
  eventId: string;
  items: any[];
  /** Each item's revision before the undo, as AppliedReviewResult reports it for a review. */
  baseRevisions: Record<string, number>;
}

function sortedKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]));
}

// A device that pushes the reviewed item back can store the same schedule with its keys in another order.
function sameSrs(stored: string, applied: string): boolean {
  if (stored === applied) return true;
  try {
    return JSON.stringify(sortedKeys(JSON.parse(stored))) === JSON.stringify(sortedKeys(JSON.parse(applied)));
  } catch {
    return false;
  }
}

const undoReviewTransaction = db.transaction((
  eventId: string,
  userId: string,
): { undone: boolean; itemIds: string[]; baseRevisions: Record<string, number> } | null => {
  const event = reviewStmts.byId.get(eventId) as any;
  if (!event) return null;
  if (event.user_id !== userId) throw new Error('Review event id belongs to another user');

  const snapshots = reviewStmts.snapshotsByEvent.all(eventId) as ReviewSnapshotRow[];
  if (snapshots.length === 0) throw new Error('Review event cannot be undone');
  const itemIds = snapshots.map(snapshot => snapshot.item_id);
  // A retried undo reports no base: the undo's own revision isn't stored.
  if (event.undone_at !== null) return { undone: false, itemIds, baseRevisions: {} };

  const baseRevisions: Record<string, number> = {};
  for (const snapshot of snapshots) {
    const row = stmts.getByIdScoped.get(snapshot.item_id, userId) as ItemRow | undefined;
    if (!row || row.is_deleted === 1 || !sameSrs(row.srs, snapshot.applied_srs)) {
      throw new Error('Review is no longer the latest change for this item');
    }
    baseRevisions[snapshot.item_id] = row.revision;
  }

  const now = Date.now();
  for (const snapshot of snapshots) {
    const revision = (nextRevision.get() as { value: number }).value;
    stmts.updateSrs.run(snapshot.previous_srs, now, revision, snapshot.item_id, userId);
  }
  const marked = reviewStmts.markUndone.run(now, eventId, userId);
  if (marked.changes !== 1) throw new Error('Review undo could not be stored');
  return { undone: true, itemIds, baseRevisions };
});

export function undoReviewEvent(eventId: string, userId: string): UndoneReviewResult | null {
  const result = undoReviewTransaction(eventId, userId);
  if (!result) return null;
  return {
    undone: result.undone,
    eventId,
    items: result.itemIds.map(id => getItemById(id, userId, false)).filter(Boolean),
    baseRevisions: result.baseRevisions,
  };
}

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

/**
 * TRANSITIONAL fallback: read base64 images still inlined in items.data for rows
 * the migration hasn't reached yet. Searches top-level items, then nested phrase vocabs.
 * (Removed in a later cleanup once prod confirms zero inline images remain.)
 */
function getInlineItemImages(ids: string[], userId: string): Record<string, string> {
  const found: Record<string, string> = {};
  const inline = (url: unknown): url is string => typeof url === 'string' && url.startsWith('data:image/');
  const nested = new Set(ids);
  for (const row of stmts.getDataForIds.all(userId, JSON.stringify(ids)) as Array<{ id: string; data: string }>) {
    nested.delete(row.id);
    const data = JSON.parse(row.data);
    if (inline(data.imageUrl)) found[row.id] = data.imageUrl;
  }
  // An id without its own row might be a vocab nested in a phrase.
  if (nested.size > 0) {
    for (const row of stmts.phrasesWithInlineImages.iterate(userId) as Iterable<{ data: string }>) {
      const vocabs = JSON.parse(row.data).vocabs;
      if (!Array.isArray(vocabs)) continue;
      for (const vocab of vocabs) {
        if (nested.has(vocab?.id) && inline(vocab.imageUrl)) found[vocab.id] ??= vocab.imageUrl;
      }
    }
  }
  return found;
}

/**
 * Get the base64 image data URI for an item or vocab id.
 * Fast path: the item_images table (direct primary-key lookup).
 * Fallback: inline base64 in items.data (only until the migration finishes).
 */
export function getItemImage(id: string, userId: string): string | null {
  const imgRow = imageStmts.get.get(id, userId) as { data: Buffer | string; mime_type: string | null } | undefined;
  const stored = storedImageToDataUri(imgRow);
  if (stored) return stored;
  return getInlineItemImages([id], userId)[id] ?? null;
}

const RASTER_DATA_URI = /^data:(image\/(?:avif|gif|jpeg|png|webp));base64,(.+)$/;

/**
 * An image's bytes for the image endpoint, with their SHA-256 as a version. Blob-backed images already
 * carry that hash; a legacy or inline data URI is decoded and hashed here. Raster types only.
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
    if (!/^image\/(?:avif|gif|jpeg|png|webp)$/.test(mimeType)) return null;
    return { data: row.data, mimeType, contentHash: row.content_hash };
  }
  const match = getItemImage(id, userId)?.match(RASTER_DATA_URI);
  if (!match) return null;
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

  // Transitional fallback for any ids not yet migrated.
  const missing = ids.filter(id => !result[id]);
  if (missing.length > 0) Object.assign(result, getInlineItemImages(missing, userId));
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

/** Upsert base64 images directly into item_images (upload-on-create + recovery). */
export const upsertItemImages = db.transaction((images: Array<{ id: string; data: string }>, userId: string): number => {
  const now = Date.now();
  let count = 0;
  for (const img of images) {
    if (img && img.id && typeof img.data === 'string' && img.data.startsWith('data:image/')) {
      if (storeImage(img.id, userId, img.data, now)) count++;
    }
  }
  return count;
});

const touchStmts = {
  exists: db.prepare(`SELECT 1 FROM items WHERE id = ? AND user_id = ?`),
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
    if (touchStmts.exists.get(imageId, userId)) owners.add(imageId);
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

// ─── User CRUD ───

export function findUserByGoogleId(googleId: string): UserRow | null {
  return (userStmts.findByGoogleId.get(googleId) as UserRow) || null;
}

export function getUserCount(): number {
  return (userStmts.count.get() as { cnt: number }).cnt;
}

export const createUserAndClaimItems = db.transaction((opts: {
  googleId: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
}): UserRow => {
  const isFirstUser = getUserCount() === 0;
  const user: UserRow = {
    id: randomUUID(),
    google_id: opts.googleId,
    email: opts.email,
    display_name: opts.displayName,
    photo_url: opts.photoUrl,
    is_approved: isFirstUser ? 1 : 0,
    is_admin: isFirstUser ? 1 : 0,
    created_at: Date.now(),
  };
  userStmts.create.run(user);
  if (isFirstUser) {
    stmts.assignOrphanItems.run(user.id);
    imageStmts.assignOrphan.run(user.id);
  }
  return user;
});

export function listAllUsers(): UserRow[] {
  return userStmts.listAll.all() as UserRow[];
}

// ─── Session CRUD ───

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const sessionTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = randomUUID();
  const now = Date.now();
  const expiresAt = now + THIRTY_DAYS_MS;
  sessionStmts.create.run({ token: sessionTokenHash(token), user_id: userId, created_at: now, expires_at: expiresAt });
  return { token, expiresAt };
}

let lastSessionCleanup = 0;
export function getSessionUser(token: string): UserRow | null {
  // Periodically clean expired sessions (at most once per hour)
  const now = Date.now();
  if (now - lastSessionCleanup > 3600_000) {
    sessionStmts.deleteExpired.run(now);
    lastSessionCleanup = now;
  }
  // Only the hash of a cookie is ever looked up, so a copy of the sessions table can't be replayed as a cookie.
  return (sessionStmts.getUser.get(sessionTokenHash(token), now) as UserRow | undefined) || null;
}

export function deleteSession(token: string) {
  sessionStmts.delete.run(sessionTokenHash(token));
}

export function isDatabaseReady(): boolean {
  try {
    return (db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined)?.ok === 1;
  } catch {
    return false;
  }
}

export { db };
