import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { env } from './env.js';

// Ensure data directory exists
mkdirSync(env.DATA_DIR, { recursive: true });

const dbPath = resolve(env.DATA_DIR, 'dictprop.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

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
`);

// Migration: add user_id column to items if missing
const columns = db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[];
if (!columns.some(c => c.name === 'user_id')) {
  db.exec(`ALTER TABLE items ADD COLUMN user_id TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_user_id ON items(user_id)`);
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
} catch (e) {
  console.warn('item_images table creation:', e);
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

// ─── Item prepared statements ───

const stmts = {
  getAll: db.prepare(`SELECT * FROM items WHERE user_id = ?`),
  getAllChunk: db.prepare(`SELECT * FROM items WHERE user_id = ? LIMIT ? OFFSET ?`),
  getCount: db.prepare(`SELECT COUNT(*) as count FROM items WHERE user_id = ?`),
  getSince: db.prepare(`SELECT * FROM items WHERE user_id = ? AND (updated_at > ? OR (updated_at IS NULL AND saved_at > ?))`),
  upsert: db.prepare(`
    INSERT INTO items (id, type, data, srs, saved_at, updated_at, is_deleted, is_archived, user_id, project)
    VALUES (@id, @type, @data, @srs, @saved_at, @updated_at, @is_deleted, @is_archived, @user_id, @project)
    ON CONFLICT(id) DO UPDATE SET
      type = @type,
      data = @data,
      srs = @srs,
      saved_at = @saved_at,
      updated_at = @updated_at,
      is_deleted = @is_deleted,
      is_archived = @is_archived,
      project = @project
  `),
  softDelete: db.prepare(`UPDATE items SET is_deleted = 1, updated_at = ? WHERE id = ? AND user_id = ?`),
  getByIdScoped: db.prepare(`SELECT * FROM items WHERE id = ? AND user_id = ?`),
  assignOrphanItems: db.prepare(`UPDATE items SET user_id = ? WHERE user_id IS NULL`),
  getImageData: db.prepare(`SELECT data FROM items WHERE id = ? AND user_id = ?`),
  findVocabInPhrase: db.prepare(`SELECT data FROM items WHERE type = 'phrase' AND user_id = ? AND data LIKE ? LIMIT 1`),
};

// ─── Comparison prepared statements + accessors ───

const compStmts = {
  getAll: db.prepare(`SELECT key, words, data, updated_at FROM comparisons WHERE user_id = ?`),
  upsert: db.prepare(`
    INSERT INTO comparisons (key, user_id, words, data, updated_at)
    VALUES (@key, @user_id, @words, @data, @updated_at)
    ON CONFLICT(key, user_id) DO UPDATE SET words = @words, data = @data, updated_at = @updated_at
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

export function upsertComparison(userId: string, key: string, words: string[], data: any, updatedAt: number): void {
  compStmts.upsert.run({
    key,
    user_id: userId,
    words: JSON.stringify(words),
    data: JSON.stringify(data),
    updated_at: updatedAt,
  });
}

// ─── Image (item_images) prepared statements ───

const imageStmts = {
  upsert: db.prepare(`
    INSERT INTO item_images (id, user_id, data, updated_at)
    VALUES (@id, @user_id, @data, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      user_id = @user_id,
      data = @data,
      updated_at = @updated_at
  `),
  get: db.prepare(`SELECT data FROM item_images WHERE id = ? AND user_id = ?`),
  manifest: db.prepare(`SELECT id FROM item_images WHERE user_id = ?`),
  allIdsForUser: db.prepare(`SELECT id FROM item_images WHERE user_id = ?`),
  assignOrphan: db.prepare(`UPDATE item_images SET user_id = ? WHERE user_id IS NULL`),
};

/**
 * Incremental, crash-resumable migration: pull base64 images out of items.data into
 * the item_images table. Invoked from index.ts AFTER serve() (in the background), NOT
 * at import — a synchronous pass over ~150MB would block the boot and the port would
 * never open. It yields to the event loop between batches so /api/health and reads stay
 * responsive while it runs; reads fall back to inline base64 for any not-yet-migrated row.
 *
 * - Resumable: "no rows still contain data:image/" IS the done-state (no flag needed).
 * - Forward-progress guaranteed: walks by rowid high-water mark, so it terminates
 *   even if a stray "data:image/" substring lingers in some non-image field.
 * - Atomic per batch: each batch inserts into item_images first, then strips the
 *   row's data, in one transaction — a crash leaves the row fully migrated or untouched.
 * - Bounded memory: small batches keep peak RSS low on the 1GB VPS. No VACUUM.
 */
export async function migrateInlineImages() {
  const BATCH = 20;
  const selectBatch = db.prepare(
    `SELECT rowid AS rid, id, data, user_id FROM items
     WHERE rowid > ? AND data LIKE '%data:image/%' ORDER BY rowid LIMIT ${BATCH}`
  );
  const updateData = db.prepare(`UPDATE items SET data = ? WHERE rowid = ?`);

  const runBatch = db.transaction((rows: Array<{ rid: number; id: string; data: string; user_id: string | null }>) => {
    let imagesInBatch = 0;
    const now = Date.now();
    for (const row of rows) {
      let data: any;
      try { data = JSON.parse(row.data); } catch { continue; } // skip unparseable rows

      const images: Array<{ id: string; data: string }> = [];
      if (typeof data.imageUrl === 'string' && data.imageUrl.startsWith('data:image/')) {
        if (data.id) images.push({ id: data.id, data: data.imageUrl });
        delete data.imageUrl;
      }
      if (Array.isArray(data.vocabs)) {
        for (const v of data.vocabs) {
          if (v && typeof v.imageUrl === 'string' && v.imageUrl.startsWith('data:image/')) {
            if (v.id) images.push({ id: v.id, data: v.imageUrl });
            delete v.imageUrl;
          }
        }
      }

      if (images.length === 0) continue; // LIKE matched a stray substring — leave row as-is
      // Insert images FIRST, then rewrite the (now image-free) row.
      for (const img of images) {
        imageStmts.upsert.run({ id: img.id, user_id: row.user_id, data: img.data, updated_at: now });
      }
      updateData.run(JSON.stringify(data), row.rid);
      imagesInBatch += images.length;
    }
    return imagesInBatch;
  });

  let mark = 0;
  let totalRows = 0;
  let totalImages = 0;
  for (;;) {
    // Yield to the event loop before each batch so the server stays responsive
    // (the port is already open; health checks and reads run in these gaps).
    await new Promise((r) => setTimeout(r, 0));
    const rows = selectBatch.all(mark) as Array<{ rid: number; id: string; data: string; user_id: string | null }>;
    if (rows.length === 0) break;
    totalImages += runBatch(rows);
    totalRows += rows.length;
    mark = rows[rows.length - 1].rid;
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  }
  if (totalImages > 0) {
    console.log(`[migrate] item_images: extracted ${totalImages} inline image(s) from ${totalRows} row(s)`);
  }
}

// ─── User / Session prepared statements ───

const userStmts = {
  findByGoogleId: db.prepare(`SELECT * FROM users WHERE google_id = ?`),
  create: db.prepare(`
    INSERT INTO users (id, google_id, email, display_name, photo_url, is_approved, is_admin, created_at)
    VALUES (@id, @google_id, @email, @display_name, @photo_url, @is_approved, @is_admin, @created_at)
  `),
  count: db.prepare(`SELECT COUNT(*) as cnt FROM users`),
  approve: db.prepare(`UPDATE users SET is_approved = 1 WHERE id = ?`),
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

function rowToItem(row: ItemRow, stripImages = false, imageIds?: Set<string>) {
  const data = JSON.parse(row.data);
  if (stripImages) {
    // An image exists if it's in item_images (post-migration) OR still inline (transition).
    // Replace it with a marker so the client knows to fetch it via the image endpoint.
    const hasImage = (id: string, url: any): boolean =>
      (!!imageIds && imageIds.has(id)) || (typeof url === 'string' && url.startsWith('data:image/'));
    if (hasImage(data.id, data.imageUrl)) {
      data.imageUrl = 'server:has_image';
    }
    if (Array.isArray(data.vocabs)) {
      data.vocabs = data.vocabs.map((v: any) => {
        if (hasImage(v.id, v.imageUrl)) {
          return { ...v, imageUrl: 'server:has_image' };
        }
        return v;
      });
    }
  }
  return {
    type: row.type,
    data,
    srs: JSON.parse(row.srs),
    savedAt: row.saved_at,
    updatedAt: row.updated_at ?? undefined,
    isDeleted: row.is_deleted === 1 ? true : undefined,
    isArchived: row.is_archived === 1 ? true : undefined,
    project: row.project ?? undefined,
  };
}

// ─── Item CRUD (all scoped by userId) ───

/** Set of all ids (item + vocab) that have an image, for cheap "has image" marking. */
function getImageIdSet(userId: string): Set<string> {
  const rows = imageStmts.allIdsForUser.all(userId) as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
}

/** Inject base64 from item_images back into already-parsed items (the ?images=true path). */
function rehydrateImages(items: any[], userId: string) {
  const rows = db.prepare(`SELECT id, data FROM item_images WHERE user_id = ?`).all(userId) as Array<{ id: string; data: string }>;
  if (rows.length === 0) return;
  const map = new Map(rows.map(r => [r.id, r.data]));
  for (const item of items) {
    const d = item.data as any;
    const top = map.get(d.id);
    if (top) d.imageUrl = top;
    if (Array.isArray(d.vocabs)) {
      for (const v of d.vocabs) {
        const vi = map.get(v.id);
        if (vi) v.imageUrl = vi;
      }
    }
  }
}

export function getAllItems(stripImages = false, userId: string) {
  if (!stripImages) {
    // Full load (?images=true) — rehydrate base64 from item_images back into the data.
    const items = (stmts.getAll.all(userId) as ItemRow[]).map(r => rowToItem(r, false));
    rehydrateImages(items, userId);
    return items;
  }
  // Stripped list path: images live in item_images, so items.data is now tiny.
  // One cheap id-only query tells us which items/vocabs to mark as having an image.
  const imageIds = getImageIdSet(userId);
  const CHUNK = 200;
  const { count } = stmts.getCount.get(userId) as { count: number };
  const items: any[] = [];
  for (let offset = 0; offset < count; offset += CHUNK) {
    const rows = stmts.getAllChunk.all(userId, CHUNK, offset) as ItemRow[];
    for (const row of rows) {
      items.push(rowToItem(row, true, imageIds));
    }
    // rows array goes out of scope here, allowing GC to reclaim the raw data
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

export function getItemsSince(since: number, stripImages = false, userId: string) {
  const imageIds = stripImages ? getImageIdSet(userId) : undefined;
  const items: any[] = [];
  for (const row of stmts.getSince.iterate(userId, since, since) as Iterable<ItemRow>) {
    items.push(rowToItem(row, stripImages, imageIds));
  }
  if (!stripImages) rehydrateImages(items, userId);
  return items;
}

export function upsertItem(item: any, userId: string) {
  const data = item.data;
  if (!data || !data.id) throw new Error('Item missing data.id');

  const now = Date.now();

  // Capture any incoming base64 into item_images, then strip imageUrl from the data we
  // store — base64 and markers ('idb:stored'/'server:has_image') never live in items.data.
  // For markers / missing / non-base64, we leave item_images untouched (and NEVER delete:
  // a vocab id can be shared with a standalone item). This replaces the old fragile,
  // index-based image-preservation, which could clobber real images with markers.
  const captureImage = (id: string | undefined, url: unknown) => {
    if (id && typeof url === 'string' && url.startsWith('data:image/')) {
      imageStmts.upsert.run({ id, user_id: userId, data: url, updated_at: now });
    }
  };

  captureImage(data.id, data.imageUrl);
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

  stmts.upsert.run({
    id: data.id,
    type: item.type,
    data: JSON.stringify(finalData),
    srs: JSON.stringify(item.srs),
    saved_at: item.savedAt || now,
    updated_at: item.updatedAt || now,
    is_deleted: item.isDeleted ? 1 : 0,
    is_archived: item.isArchived ? 1 : 0,
    user_id: userId,
    project: item.project || null,
  });
}

export const upsertMany = db.transaction((items: any[], userId: string) => {
  for (const item of items) {
    upsertItem(item, userId);
  }
});

export function softDeleteItem(id: string, userId: string) {
  stmts.softDelete.run(Date.now(), id, userId);
}

export function getItemById(id: string, userId: string) {
  const row = stmts.getByIdScoped.get(id, userId) as ItemRow | undefined;
  if (!row) return null;
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
 * TRANSITIONAL fallback: read a base64 image still inlined in items.data for rows
 * the migration hasn't reached yet. Searches top-level items, then nested phrase vocabs.
 * (Removed in a later cleanup once prod confirms zero inline images remain.)
 */
function getInlineItemImage(id: string, userId: string): string | null {
  const row = stmts.getImageData.get(id, userId) as { data: string } | undefined;
  if (row) {
    const data = JSON.parse(row.data);
    if (data.imageUrl?.startsWith('data:image/')) return data.imageUrl;
    return null;
  }

  // id might be a vocab id nested in a phrase
  const phraseRow = stmts.findVocabInPhrase.get(userId, `%"id":"${id}"%`) as { data: string } | undefined;
  if (phraseRow) {
    const data = JSON.parse(phraseRow.data);
    if (Array.isArray(data.vocabs)) {
      const vocab = data.vocabs.find((v: any) => v.id === id);
      if (vocab?.imageUrl?.startsWith('data:image/')) return vocab.imageUrl;
    }
  }

  return null;
}

/**
 * Get the base64 image data URI for an item or vocab id.
 * Fast path: the item_images table (direct primary-key lookup).
 * Fallback: inline base64 in items.data (only until the migration finishes).
 */
export function getItemImage(id: string, userId: string): string | null {
  const imgRow = imageStmts.get.get(id, userId) as { data: string } | undefined;
  if (imgRow?.data) return imgRow.data;
  return getInlineItemImage(id, userId);
}

/**
 * Get base64 image data URIs for multiple ids in one call.
 * Returns a map of { id: dataUri } for ids that have images.
 */
export function getItemImagesBatch(ids: string[], userId: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (ids.length === 0) return result;

  // Fast path: one IN query against item_images.
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, data FROM item_images WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...ids) as Array<{ id: string; data: string }>;
  for (const r of rows) if (r.data) result[r.id] = r.data;

  // Transitional fallback for any ids not yet migrated.
  for (const id of ids) {
    if (!result[id]) {
      const inline = getInlineItemImage(id, userId);
      if (inline) result[id] = inline;
    }
  }
  return result;
}

/** All image ids this user has stored — for the recovery diff (client uploads what's missing). */
export function getImageManifest(userId: string): string[] {
  return (imageStmts.manifest.all(userId) as Array<{ id: string }>).map(r => r.id);
}

/** Upsert base64 images directly into item_images (upload-on-create + recovery). */
export const upsertItemImages = db.transaction((images: Array<{ id: string; data: string }>, userId: string): number => {
  const now = Date.now();
  let count = 0;
  for (const img of images) {
    if (img && img.id && typeof img.data === 'string' && img.data.startsWith('data:image/')) {
      imageStmts.upsert.run({ id: img.id, user_id: userId, data: img.data, updated_at: now });
      count++;
    }
  }
  return count;
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

export function approveUser(userId: string) {
  userStmts.approve.run(userId);
}

export function listAllUsers(): UserRow[] {
  return userStmts.listAll.all() as UserRow[];
}

// ─── Session CRUD ───

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = randomUUID();
  const now = Date.now();
  const expiresAt = now + THIRTY_DAYS_MS;
  sessionStmts.create.run({ token, user_id: userId, created_at: now, expires_at: expiresAt });
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
  return (sessionStmts.getUser.get(token, now) as UserRow) || null;
}

export function deleteSession(token: string) {
  sessionStmts.delete.run(token);
}

// ─── Project CRUD ───

let projectStmts = {
  getAll: db.prepare(`SELECT * FROM projects WHERE user_id = ? ORDER BY created_at`),
  create: db.prepare(`INSERT INTO projects (id, name, user_id, created_at) VALUES (@id, @name, @user_id, @created_at)`),
  rename: db.prepare(`UPDATE projects SET name = ? WHERE id = ? AND user_id = ?`),
  delete: db.prepare(`DELETE FROM projects WHERE id = ? AND user_id = ?`),
  clearItemsProject: db.prepare(`UPDATE items SET project = NULL, updated_at = ? WHERE project = ? AND user_id = ?`),
};

export interface ProjectRow {
  id: string;
  name: string;
  user_id: string;
  created_at: number;
}

export function getProjects(userId: string): ProjectRow[] {
  try {
    return projectStmts.getAll.all(userId) as ProjectRow[];
  } catch (e: any) {
    if (e.message?.includes('no such table')) {
      db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
      projectStmts.getAll = db.prepare(`SELECT * FROM projects WHERE user_id = ? ORDER BY created_at`);
      return projectStmts.getAll.all(userId) as ProjectRow[];
    }
    throw e;
  }
}

export function createProject(id: string, name: string, userId: string) {
  try {
    projectStmts.create.run({ id, name, user_id: userId, created_at: Date.now() });
  } catch (e: any) {
    // Table might not exist — create it and retry
    if (e.message?.includes('no such table')) {
      db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
      // Re-prepare the statement since table was just created
      projectStmts.create = db.prepare(`INSERT INTO projects (id, name, user_id, created_at) VALUES (@id, @name, @user_id, @created_at)`);
      projectStmts.create.run({ id, name, user_id: userId, created_at: Date.now() });
    } else {
      throw e;
    }
  }
}

export function renameProject(id: string, name: string, userId: string) {
  projectStmts.rename.run(name, id, userId);
}

export const deleteProject = db.transaction((id: string, userId: string) => {
  // Clear project from all items that belonged to it
  projectStmts.clearItemsProject.run(Date.now(), id, userId);
  projectStmts.delete.run(id, userId);
});

export { db };
