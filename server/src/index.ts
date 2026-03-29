import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from './env.js';
import { authRoutes } from './routes/auth.js';
import { itemsRoutes } from './routes/items.js';
import { aiRoutes } from './routes/ai.js';
import { imageRoutes } from './routes/images.js';
import { requireAuth, type AuthVariables } from './middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new Hono<{ Variables: AuthVariables }>();

// Middleware
app.use('*', logger());
app.use('*', compress());
app.use('*', cors({
  origin: ['https://dictprop.online', 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));

// Auth routes (public — before auth middleware)
app.route('/api/auth', authRoutes);

// Auth middleware for all other /api/* routes (skips /api/health and /api/auth/*)
app.use('/api/*', requireAuth);

// API routes
app.route('/api', itemsRoutes);
app.route('/api', aiRoutes);
app.route('/api', imageRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// Serve static files from dist/ (built frontend)
const distDir = resolve(__dirname, '../../dist');
app.use('/*', serveStatic({ root: distDir }));

// SPA fallback — serve index.html for all non-API, non-file routes
app.get('*', serveStatic({ root: distDir, path: 'index.html' }));

console.log(`DictProp server starting on port ${env.PORT}...`);

serve({
  fetch: app.fetch,
  port: env.PORT,
});

console.log(`Server running at http://localhost:${env.PORT}`);
