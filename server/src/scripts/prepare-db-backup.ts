// Run in the app container by .github/workflows/offsite-backup.yml (node server/dist/scripts/prepare-db-backup.js).
// Makes sure the backup slot, DATA_DIR/backups, holds a recent whole copy of the database, and prints one JSON line
// that describes it; the workflow packs that line as manifest.json, with the copy and the live Caddyfile, into the
// off-site backup. The copy is the slot's newest one while it is under twelve hours old, as imports and deploys reuse
// it, and a fresh pre-offsite-<time>.db otherwise, so the disk still holds a single copy. Nothing here checks the
// copy's integrity: reading the whole database on the 2 GB VPS every week costs more than it tells, so ops/RESTORE.md
// runs PRAGMA quick_check on the copy a restore uses instead.

import { statSync } from 'node:fs';
import { basename } from 'node:path';

// The workflow takes standard output for the manifest, so whatever the modules below log goes to standard error.
console.log = console.error;
console.info = console.error;

const { default: Database } = await import('better-sqlite3');
const { backupBeforeWrite } = await import('../import-support.js');

// What a restored copy is checked against: the accounts, the library with its reviews and images, the example
// enrichments and the saved comparisons. A table the database doesn't have is left out.
const COUNTED_TABLES = ['users', 'items', 'review_events', 'item_images', 'image_blobs', 'sentence_enrichments', 'comparisons'];

// Both writers name a copy for the moment they started it, pre-<operation>-<time>.db and dictprop-<time>-<sha>.db,
// which is when its snapshot was taken; the file's own time is when the copy was finished.
const NAME_TIME = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/;

function snapshotTime(name: string, modifiedAtMs: number): string {
  const parts = NAME_TIME.exec(name)?.slice(1).map(Number);
  if (!parts) return new Date(modifiedAtMs).toISOString();
  const [year, month, day, hour, minute, second] = parts;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

const path = await backupBeforeWrite('offsite');
const { size, mtimeMs } = statSync(path);
const copy = new Database(path, { readonly: true, fileMustExist: true });
let manifest;
try {
  const tables = new Set(copy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all());
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    if (tables.has(table)) counts[table] = copy.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get() as number;
  }
  manifest = {
    version: 1,
    copy: basename(path),
    bytes: size,
    pageSize: copy.pragma('page_size', { simple: true }) as number,
    pageCount: copy.pragma('page_count', { simple: true }) as number,
    counts,
    createdAt: snapshotTime(basename(path), mtimeMs),
  };
} finally {
  copy.close();
}
process.stdout.write(`${JSON.stringify(manifest)}\n`);
