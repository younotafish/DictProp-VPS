import { db } from './connection.js';

// One clock orders every change to every item, so a device can ask for the changes after the last revision it saw.
const stmts = {
  head: db.prepare(`SELECT value FROM sync_meta WHERE key = 'item_revision'`),
  next: db.prepare(`UPDATE sync_meta SET value = value + 1 WHERE key = 'item_revision' RETURNING value`),
};

/** Advance the clock and return the new revision, for a change committing in the current transaction. */
export const allocateRevision = (): number => (stmts.next.get() as { value: number }).value;

/** The newest revision the server has issued. */
export const headRevision = (): number => (stmts.head.get() as { value: number } | undefined)?.value ?? 0;
