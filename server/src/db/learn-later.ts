import type { LearnLaterChange, LearnLaterResponse } from '../shared/learn-later.js';
import { db, writeTransaction } from './connection.js';

// Learn later (shared/learn-later.ts): each item's latest star or unstar for a user. A change replaces the stored one
// only when it was made later, so a device sending an old change late never takes back a newer one.

const stmts = {
  upsert: db.prepare(`INSERT INTO learn_later (user_id, item_id, starred, changed_at, updated_at)
    VALUES (@user_id, @item_id, @starred, @changed_at, @updated_at)
    ON CONFLICT (user_id, item_id) DO UPDATE SET starred = excluded.starred, changed_at = excluded.changed_at,
      updated_at = excluded.updated_at
    WHERE excluded.changed_at > learn_later.changed_at`),
  all: db.prepare(`SELECT item_id, starred, changed_at FROM learn_later WHERE user_id = ?`),
  one: db.prepare(`SELECT starred, changed_at FROM learn_later WHERE user_id = ? AND item_id = ?`),
  starredCount: db.prepare(`SELECT COUNT(*) FROM learn_later WHERE user_id = ? AND starred = 1`).pluck(),
};

/** Applies each change for `userId` that is later than the one stored for its item. */
export const recordLearnLaterChanges = writeTransaction((userId: string, changes: readonly LearnLaterChange[], now: number): void => {
  for (const change of changes) {
    stmts.upsert.run({
      user_id: userId, item_id: change.itemId, starred: change.starred ? 1 : 0, changed_at: change.changedAt, updated_at: now,
    });
  }
});

/** Every item's latest change for `userId`, keyed in a map with no prototype (an item id can be any string). */
export function getLearnLater(userId: string): LearnLaterResponse {
  const items: LearnLaterResponse['items'] = Object.create(null);
  for (const row of stmts.all.all(userId) as { item_id: string; starred: number; changed_at: number }[]) {
    items[row.item_id] = { starred: row.starred === 1, changedAt: row.changed_at };
  }
  return { items };
}

/** How many items `userId` has starred. */
export const getLearnLaterCount = (userId: string): number => stmts.starredCount.get(userId) as number;

/** The latest change stored for each of `itemIds`. */
export function getLearnLaterFor(userId: string, itemIds: readonly string[]): LearnLaterResponse['items'] {
  const items: LearnLaterResponse['items'] = Object.create(null);
  for (const itemId of itemIds) {
    const row = stmts.one.get(userId, itemId) as { starred: number; changed_at: number } | undefined;
    if (row) items[itemId] = { starred: row.starred === 1, changedAt: row.changed_at };
  }
  return items;
}
