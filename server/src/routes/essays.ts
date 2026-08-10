import { Hono } from 'hono';
import type { AuthVariables } from '../middleware/auth.js';
import { getPrivateEssayCatalog } from '../essay-catalog.js';

type EssaysEnv = { Variables: AuthVariables };

export const essaysRoutes = new Hono<EssaysEnv>();

// The static public-domain collection ships with the client. This endpoint contains only the
// owner-private catalog stored on the VPS data volume, so it remains behind requireAuth.
essaysRoutes.get('/essays/catalog', c => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return c.json(getPrivateEssayCatalog());
});
