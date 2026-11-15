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
// In WAL mode NORMAL can lose only the last commits on power loss, never corrupt the file. Importers write
// this file while the server runs, so a writer that asks for the write lock while another process holds it
// waits up to busy_timeout (see writeTransaction), and a checkpointed WAL shrinks back instead of keeping its
// largest size on the small disk.
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 10000');
db.pragma('journal_size_limit = 67108864');

applySchema(db);

/**
 * `fn` as a transaction that takes the write lock as it begins (BEGIN IMMEDIATE), for every write that reads
 * first. SQLite waits out busy_timeout only for a transaction that asks for the write lock before reading:
 * one that reads and then writes fails at once with SQLITE_BUSY while an importer holds the lock. The wait
 * blocks this process, so importers keep their transactions short. Called inside another transaction (an
 * importer's chunk), it runs as a savepoint of that one.
 */
export function writeTransaction<A extends unknown[], R>(fn: (...args: A) => R): Database.Transaction<(...args: A) => R> {
  // better-sqlite3 gives each variant of a transaction the others as properties, so the immediate variant is
  // a whole Transaction whose plain call begins IMMEDIATE.
  return db.transaction(fn).immediate as Database.Transaction<(...args: A) => R>;
}

export function isDatabaseReady(): boolean {
  try {
    return (db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined)?.ok === 1;
  } catch {
    return false;
  }
}

export { db };
