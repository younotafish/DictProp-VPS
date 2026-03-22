/**
 * Import script: loads a JSON array of StoredItems into the SQLite database.
 *
 * Usage:
 *   1. Export items from the browser:
 *      - Open DictProp in browser, open DevTools console
 *      - Run: (async () => { const db = await new Promise(r => { const req = indexedDB.open('PopDictDB', 2); req.onsuccess = () => r(req.result); }); const tx = db.transaction('library', 'readonly'); const store = tx.objectStore('library'); const keys = await new Promise(r => { const req = store.getAllKeys(); req.onsuccess = () => r(req.result); }); for (const key of keys) { const data = await new Promise(r => { const req = store.get(key); req.onsuccess = () => r(req.result); }); if (Array.isArray(data)) { const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `dictprop-export-${key}.json`; a.click(); } } })()
 *      - This downloads the items as a JSON file
 *
 *   2. Run this script:
 *      cd server && npx tsx src/scripts/import-json.ts ../path/to/export.json
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { config } from 'dotenv';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const DATA_DIR = process.env.DATA_DIR || resolve(__dirname, '../../../data');
const dbPath = resolve(DATA_DIR, 'dictprop.db');

// Get input file from args
const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: npx tsx src/scripts/import-json.ts <path-to-json-file>');
  process.exit(1);
}

const filePath = resolve(process.cwd(), inputFile);
console.log(`Reading from: ${filePath}`);

const raw = readFileSync(filePath, 'utf-8');
const items = JSON.parse(raw);

if (!Array.isArray(items)) {
  console.error('Expected a JSON array of StoredItems');
  process.exit(1);
}

console.log(`Found ${items.length} items`);

// Open/create database
const { mkdirSync } = await import('fs');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

const upsert = db.prepare(`
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
`);

const importAll = db.transaction((items: any[]) => {
  let imported = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.data || !item.data.id || !item.type) {
      skipped++;
      continue;
    }

    upsert.run({
      id: item.data.id,
      type: item.type,
      data: JSON.stringify(item.data),
      srs: JSON.stringify(item.srs || {}),
      saved_at: item.savedAt || Date.now(),
      updated_at: item.updatedAt || Date.now(),
      is_deleted: item.isDeleted ? 1 : 0,
      is_archived: item.isArchived ? 1 : 0,
    });
    imported++;
  }

  return { imported, skipped };
});

const result = importAll(items);
console.log(`Import complete: ${result.imported} imported, ${result.skipped} skipped`);
console.log(`Database: ${dbPath}`);

db.close();
