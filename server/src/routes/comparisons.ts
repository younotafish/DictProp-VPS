// Word-comparison persistence. Saved analyses live in their own table (see db.ts) keyed by the
// normalized word-set, so a "parable vs fable" comparison surfaces on both words' pages. requireAuth
// (mounted on /api/*) gates these — comparisons are per-user.
import { Hono } from 'hono';
import { getComparisons, upsertComparison } from '../db.js';
import type { AuthVariables } from '../middleware/auth.js';

export const comparisonsRoutes = new Hono<{ Variables: AuthVariables }>();

// A comparison covers two or three words of at most 100 characters (see /api/compare); these caps leave
// room for that and stop a client from storing arbitrary keys.
const MAX_KEY_LENGTH = 1_000;
const MAX_WORDS = 10;
const MAX_WORD_LENGTH = 200;
// A device with a fast clock would otherwise stamp a comparison no later save could replace.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// GET /api/comparisons — all saved comparisons for the user (small JSON, no images).
comparisonsRoutes.get('/comparisons', (c) => {
  const userId = c.get('user').id;
  return c.json(getComparisons(userId));
});

// PUT /api/comparisons — upsert one comparison: { key, words, data, updatedAt }.
comparisonsRoutes.put('/comparisons', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json().catch(() => ({}));
  const { key, words, data, updatedAt } = body || {};
  if (typeof key !== 'string' || !key || !Array.isArray(words) || !data || typeof data !== 'object') {
    return c.json({ error: 'key, words[], and data are required' }, 400);
  }
  if (key.length > MAX_KEY_LENGTH || words.length === 0 || words.length > MAX_WORDS ||
      !words.every(word => typeof word === 'string' && word.length > 0 && word.length <= MAX_WORD_LENGTH)) {
    return c.json({ error: `Expected a key of at most ${MAX_KEY_LENGTH} characters and 1-${MAX_WORDS} words` }, 400);
  }
  const now = Date.now();
  const savedAt = typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0
    ? Math.min(updatedAt, now + MAX_CLOCK_SKEW_MS)
    : now;
  // An older copy than the stored one is acknowledged but not written.
  upsertComparison(userId, key, words, data, savedAt);
  return c.json({ ok: true });
});
