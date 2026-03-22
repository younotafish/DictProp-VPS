import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
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
`);

// Prepared statements
const stmts = {
  getAll: db.prepare(`SELECT * FROM items`),
  getSince: db.prepare(`SELECT * FROM items WHERE updated_at > ? OR (updated_at IS NULL AND saved_at > ?)`),
  upsert: db.prepare(`
    INSERT INTO items (id, type, data, srs, saved_at, updated_at, is_deleted, is_archived)
    VALUES (@id, @type, @data, @srs, @saved_at, @updated_at, @is_deleted, @is_archived)
    ON CONFLICT(id) DO UPDATE SET
      type = @type,
      data = @data,
      srs = @srs,
      saved_at = @saved_at,
      updated_at = @updated_at,
      is_deleted = @is_deleted,
      is_archived = @is_archived
  `),
  softDelete: db.prepare(`UPDATE items SET is_deleted = 1, updated_at = ? WHERE id = ?`),
  getById: db.prepare(`SELECT * FROM items WHERE id = ?`),
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
}

function rowToItem(row: ItemRow, stripImages = false) {
  const data = JSON.parse(row.data);
  if (stripImages) {
    delete data.imageUrl;
    if (Array.isArray(data.vocabs)) {
      data.vocabs = data.vocabs.map((v: any) => {
        const { imageUrl, ...rest } = v;
        return rest;
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

export function getAllItems(stripImages = false) {
  const rows = stmts.getAll.all() as ItemRow[];
  return rows.map(r => rowToItem(r, stripImages));
}

export function getItemsSince(since: number, stripImages = false) {
  const rows = stmts.getSince.all(since, since) as ItemRow[];
  return rows.map(r => rowToItem(r, stripImages));
}

export function upsertItem(item: any) {
  const data = item.data;
  if (!data || !data.id) throw new Error('Item missing data.id');

  // Preserve existing images when client sends marker ('idb:stored') or no image.
  // Client strips base64 images from React state to save memory; server is source of truth.
  let finalData = data;
  const existingRow = stmts.getById.get(data.id) as ItemRow | undefined;
  if (existingRow) {
    const existingData = JSON.parse(existingRow.data);
    const needsImagePreserve = (url: string | undefined) =>
      !url || url === 'idb:stored' || !url.startsWith('data:image/');

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
  });
}

export const upsertMany = db.transaction((items: any[]) => {
  for (const item of items) {
    upsertItem(item);
  }
});

export function softDeleteItem(id: string) {
  stmts.softDelete.run(Date.now(), id);
}

export function getItemById(id: string) {
  const row = stmts.getById.get(id) as ItemRow | undefined;
  return row ? rowToItem(row) : null;
}

export { db };
