import { mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'fs';
import { resolve } from 'path';
import { db, upsertItem } from './db.js';
import { env } from './env.js';

const BACKUP_PREFIX = 'pre-';
// The deploy workflow copies the database into the same directory as dictprop-<timestamp>-<sha>.db.
const COPY_PREFIXES = [BACKUP_PREFIX, 'dictprop-'];
// The deploy workflow reuses a copy for as long.
const REUSE_BACKUP_MS = 12 * 60 * 60 * 1000;
// Room the live database keeps for its WAL and the rows an import adds once the copy is written.
const FREE_SPACE_RESERVE = 512 * 1024 * 1024;

const isCopy = (name: string) => COPY_PREFIXES.some(prefix => name.startsWith(prefix));

// A copy is in WAL mode like the live database, so opening it to inspect it leaves -wal and -shm files, and
// the deploy workflow marks a copy it has checked with a .verified file.
function removeCopy(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '.verified']) rmSync(`${path}${suffix}`, { force: true });
}

/**
 * Copy the live database to backups/pre-<operation>-<timestamp>.db in the data dir before a script writes
 * it. Each copy is the whole database and the disk only has room for one beside the copy being written,
 * so imports and deploys share one slot: a copy of either kind younger than twelve hours is reused, as
 * the deploy workflow does, and a repair asks for a fresh one. The older copy stays until the new one is
 * complete, and a copy that would leave the disk nearly full is refused before anything is written.
 */
export async function backupBeforeWrite(operation: string, options: { reuseRecent?: boolean } = {}): Promise<string> {
  const dir = resolve(env.DATA_DIR, 'backups');
  mkdirSync(dir, { recursive: true });
  const names = readdirSync(dir);
  // Imports and deploys never run at once, so a partial copy is one a crashed run left behind.
  for (const name of names) {
    if (isCopy(name) && name.endsWith('.db.partial')) rmSync(resolve(dir, name), { force: true });
  }
  const copies = names
    .filter(name => isCopy(name) && name.endsWith('.db'))
    .map(name => ({ path: resolve(dir, name), modifiedAt: statSync(resolve(dir, name)).mtimeMs }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  if (options.reuseRecent !== false && copies[0] && Date.now() - copies[0].modifiedAt < REUSE_BACKUP_MS) {
    return copies[0].path;
  }
  for (const copy of copies.slice(1)) removeCopy(copy.path);

  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const needed = pageCount * pageSize + FREE_SPACE_RESERVE;
  const { bavail, bsize } = statfsSync(dir);
  if (bavail * bsize < needed) {
    throw new Error(`Refusing to back up before ${operation}: it needs ${Math.ceil(needed / 2 ** 20)} MiB free ` +
      `and ${Math.floor((bavail * bsize) / 2 ** 20)} MiB are`);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const target = resolve(dir, `${BACKUP_PREFIX}${operation}-${stamp}.db`);
  const partial = `${target}.partial`;
  try {
    // One step copies one consistent snapshot. Stepwise copying restarts whenever the server commits.
    await db.backup(partial, { progress: () => 0x7fffffff });
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
  for (const copy of copies) {
    // A repair in the same second as the last copy writes over it.
    if (copy.path !== target) removeCopy(copy.path);
  }
  return target;
}

/** Fold this script's writes into the database file and truncate the WAL instead of leaving it large. */
export function checkpointAfterWrite(): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/**
 * An entry whose item changed, or went away, after its bundle was built. It is skipped without failing
 * the run: the local cycle retries a failed import with the same bundle and then gives up on the whole
 * cycle, while its next export picks the item up again from the live corpus.
 */
export class StaleEntryError extends Error {}

const LISTED_STALE_IDS = 50;

export function recordStale(result: { stale: number; staleIds: string[] }, id: string): void {
  result.stale++;
  if (result.staleIds.length < LISTED_STALE_IDS) result.staleIds.push(id);
}

/**
 * Write new data over an item the caller read inside its current transaction, carrying that row's
 * revision, so an import never replaces a copy committed after it read.
 */
export function writeOverLiveItem(live: any, ownerId: string, data: any): void {
  const { conflicted } = upsertItem({
    ...live,
    data,
    updatedAt: Math.max(Date.now(), Number(live.updatedAt || 0) + 1),
  }, ownerId);
  if (conflicted) throw new StaleEntryError('item changed while it was being imported');
}
