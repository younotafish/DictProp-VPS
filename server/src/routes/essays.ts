import { Hono } from 'hono';
import { getPrivateEssayCatalog } from '../essay-catalog.js';
import type { AppEnv } from '../middleware/auth.js';

export const essaysRoutes = new Hono<AppEnv>();

// The static public-domain collection ships with the client. This endpoint contains only the
// owner-private catalog stored on the VPS data volume, so it remains behind requireAuth.
essaysRoutes.get('/essays/catalog', c => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return c.json(getPrivateEssayCatalog());
});
