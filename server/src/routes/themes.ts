// GET /api/themes: the theme rows that changed after the client's seq, and how the server's sorting stands. Only the
// sweep (themes/sweep.ts) writes theme rows: it labels the learner's own saved sentences on its own, and no client can
// ask it to classify anything.
import { Hono } from 'hono';
import { getThemeRowsAfter } from '../db.js';
import type { AppEnv } from '../middleware/auth.js';
import { THEME_TAXONOMY_VERSION, type ThemesResponse } from '../shared/item-themes.js';
import type { ThemeSweep } from '../themes/sweep.js';

export function createThemeRoutes(sweep: ThemeSweep) {
  const routes = new Hono<AppEnv>();

  // ?after=<seq>: the rows that changed since; absent or 0, every row with a theme.
  routes.get('/themes', async (c) => {
    const userId = c.get('user').id;
    const query = c.req.query('after');
    const after = query === undefined || query === '' ? 0 : Number(query);
    if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: 'Invalid after parameter' }, 400);
    const { rows, latestSeq } = getThemeRowsAfter(userId, after);
    const body: ThemesResponse = { taxonomyVersion: THEME_TAXONOMY_VERSION, rows, latestSeq, ...await sweep.report(userId) };
    c.header('Cache-Control', 'private, no-store');
    return c.json(body);
  });

  return routes;
}
