import { Hono } from 'hono';
import type { AuthVariables } from '../middleware/auth.js';
import { getRealLifeCatalogSummaries } from '../real-life-catalog.js';

type RealLifeEnv = { Variables: AuthVariables };

export function createRealLifeRoutes() {
  const routes = new Hono<RealLifeEnv>();

  // The catalog ships with the application. Analysis and artwork are prepared locally and
  // imported through the sentence-enrichment bridge; production never generates either one.
  routes.get('/real-life', c => {
    c.header('Cache-Control', 'private, max-age=300');
    return c.json({ version: 1, collections: getRealLifeCatalogSummaries() });
  });

  return routes;
}

export const realLifeRoutes = createRealLifeRoutes();
