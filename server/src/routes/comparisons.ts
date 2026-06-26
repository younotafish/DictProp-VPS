// Word-comparison persistence. Saved analyses live in their own table (see db.ts) keyed by the
// normalized word-set, so a "parable vs fable" comparison surfaces on both words' pages. requireAuth
// (mounted on /api/*) gates these — comparisons are per-user.
import { Hono } from 'hono';
import { getComparisons, upsertComparison } from '../db.js';
import type { AuthVariables } from '../middleware/auth.js';

export const comparisonsRoutes = new Hono<{ Variables: AuthVariables }>();

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
  upsertComparison(userId, key, words, data, typeof updatedAt === 'number' ? updatedAt : Date.now());
  return c.json({ ok: true });
});
