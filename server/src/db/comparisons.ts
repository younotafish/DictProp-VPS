import { db } from './connection.js';

// ─── Comparison prepared statements + accessors ───

const compStmts = {
  getAll: db.prepare(`SELECT key, words, data, updated_at FROM comparisons WHERE user_id = ?`),
  upsert: db.prepare(`
    INSERT INTO comparisons (key, user_id, words, data, updated_at)
    VALUES (@key, @user_id, @words, @data, @updated_at)
    ON CONFLICT(key, user_id) DO UPDATE SET words = @words, data = @data, updated_at = @updated_at
    WHERE excluded.updated_at >= comparisons.updated_at
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

/** Returns false when the stored comparison is newer, so a device replaying an old copy can't regress it. */
export function upsertComparison(userId: string, key: string, words: string[], data: any, updatedAt: number): boolean {
  return compStmts.upsert.run({
    key,
    user_id: userId,
    words: JSON.stringify(words),
    data: JSON.stringify(data),
    updated_at: updatedAt,
  }).changes > 0;
}
