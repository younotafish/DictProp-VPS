import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { env } from '../env.js';
import { applySchema } from './schema.js';

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

applySchema(db);

export function isDatabaseReady(): boolean {
  try {
    return (db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined)?.ok === 1;
  } catch {
    return false;
  }
}

export { db };
