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

// ─── Item prepared statements ───

const stmts = {
  getAll: db.prepare(`SELECT * FROM items WHERE user_id = ?`),
  getSince: db.prepare(`SELECT * FROM items WHERE user_id = ? AND (updated_at > ? OR (updated_at IS NULL AND saved_at > ?))`),
  upsert: db.prepare(`
    INSERT INTO items (id, type, data, srs, saved_at, updated_at, is_deleted, is_archived, user_id)
    VALUES (@id, @type, @data, @srs, @saved_at, @updated_at, @is_deleted, @is_archived, @user_id)
    ON CONFLICT(id) DO UPDATE SET
      type = @type,
      data = @data,
      srs = @srs,
      saved_at = @saved_at,
      updated_at = @updated_at,
      is_deleted = @is_deleted,
      is_archived = @is_archived
  `),
  softDelete: db.prepare(`UPDATE items SET is_deleted = 1, updated_at = ? WHERE id = ? AND user_id = ?`),
  getById: db.prepare(`SELECT * FROM items WHERE id = ?`),
  getByIdScoped: db.prepare(`SELECT * FROM items WHERE id = ? AND user_id = ?`),
  assignOrphanItems: db.prepare(`UPDATE items SET user_id = ? WHERE user_id IS NULL`),
};

// ─── User / Session prepared statements ───

const userStmts = {
  findByGoogleId: db.prepare(`SELECT * FROM users WHERE google_id = ?`),
  create: db.prepare(`
    INSERT INTO users (id, google_id, email, display_name, photo_url, is_approved, is_admin, created_at)
    VALUES (@id, @google_id, @email, @display_name, @photo_url, @is_approved, @is_admin, @created_at)
  `),
  count: db.prepare(`SELECT COUNT(*) as cnt FROM users`),
  approve: db.prepare(`UPDATE users SET is_approved = 1 WHERE id = ?`),
  getById: db.prepare(`SELECT * FROM users WHERE id = ?`),
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

function rowToItem(row: ItemRow, stripImages = false) {
  const data = JSON.parse(row.data);
  if (stripImages) {
    // Replace base64 with marker instead of deleting — client needs to know an image exists
    if (data.imageUrl && data.imageUrl.startsWith('data:image/')) {
      data.imageUrl = 'server:has_image';
    }
    if (Array.isArray(data.vocabs)) {
      data.vocabs = data.vocabs.map((v: any) => {
        if (v.imageUrl && v.imageUrl.startsWith('data:image/')) {
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
  };
}

// ─── Item CRUD (all scoped by userId) ───

export function getAllItems(stripImages = false, userId: string) {
  const rows = stmts.getAll.all(userId) as ItemRow[];
  return rows.map(r => rowToItem(r, stripImages));
}

export function getItemsSince(since: number, stripImages = false, userId: string) {
  const rows = stmts.getSince.all(userId, since, since) as ItemRow[];
  return rows.map(r => rowToItem(r, stripImages));
}

export function upsertItem(item: any, userId: string) {
  const data = item.data;
  if (!data || !data.id) throw new Error('Item missing data.id');

  // Preserve existing images when client sends marker ('idb:stored') or no image.
  // Client strips base64 images from React state to save memory; server is source of truth.
  let finalData = data;
  const existingRow = stmts.getByIdScoped.get(data.id, userId) as ItemRow | undefined;
  if (existingRow) {
    const existingData = JSON.parse(existingRow.data);
    const needsImagePreserve = (url: string | undefined) =>
      !url || url === 'idb:stored' || url === 'server:has_image' || !url.startsWith('data:image/');

    if (needsImagePreserve(data.imageUrl) && existingData.imageUrl?.startsWith('data:image/')) {
      finalData = { ...finalData, imageUrl: existingData.imageUrl };
    }

    // Preserve vocab images within phrase items
    if (Array.isArray(data.vocabs) && Array.isArray(existingData.vocabs)) {
      finalData = {
        ...finalData,
        vocabs: data.vocabs.map((v: any, i: number) => {
          const existingVocab = existingData.vocabs[i];
          if (existingVocab && needsImagePreserve(v?.imageUrl) && existingVocab.imageUrl?.startsWith('data:image/')) {
            return { ...v, imageUrl: existingVocab.imageUrl };
          }
          return v;
        }),
      };
    }
  }

  stmts.upsert.run({
    id: data.id,
    type: item.type,
    data: JSON.stringify(finalData),
    srs: JSON.stringify(item.srs),
    saved_at: item.savedAt || Date.now(),
    updated_at: item.updatedAt || Date.now(),
    is_deleted: item.isDeleted ? 1 : 0,
    is_archived: item.isArchived ? 1 : 0,
    user_id: userId,
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
  return row ? rowToItem(row) : null;
}

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
  }
  return user;
});

export function approveUser(userId: string) {
  userStmts.approve.run(userId);
}

export function getUserById(userId: string): UserRow | null {
  return (userStmts.getById.get(userId) as UserRow) || null;
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

export { db };
