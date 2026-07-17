import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
// compress removed — Caddy handles gzip at the proxy level
import { logger } from 'hono/logger';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from './env.js';
import { migrateInlineImages } from './db.js';
import { authRoutes } from './routes/auth.js';
import { itemsRoutes } from './routes/items.js';
import { aiRoutes } from './routes/ai.js';
import { imageRoutes } from './routes/images.js';
import { ttsRoutes, runBackfill } from './routes/tts.js';
import { comparisonsRoutes } from './routes/comparisons.js';
import { requireAuth, type AuthVariables } from './middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new Hono<{ Variables: AuthVariables }>();

// Global error handler — catch everything so the server never crashes from a route error
app.onError((err, c) => {
  console.error(`[FATAL] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: err.message || 'Internal server error' }, 500);
});

// Middleware
app.use('*', logger());
app.use('*', secureHeaders({
  // The app embeds third-party media and loads browser model workers, so these
  // isolation headers must remain opt-in until those resources are audited.
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));
app.use('*', cors({
  origin: [
    'https://dictprop.online',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
  ],
  credentials: true,
}));

const jsonBodyLimit = bodyLimit({
  maxSize: 512 * 1024,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
});
app.use('/api/analyze', jsonBodyLimit);
app.use('/api/compare', jsonBodyLimit);
app.use('/api/extract-vocabulary', jsonBodyLimit);
app.use('/api/generate-image', jsonBodyLimit);
app.use('/api/transcribe', bodyLimit({
  maxSize: 25 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Audio upload too large' }, 413),
}));

// Auth routes (public — before auth middleware)
app.route('/api/auth', authRoutes);

// Auth middleware for all other /api/* routes (skips /api/health and /api/auth/*)
app.use('/api/*', requireAuth);

// API routes
app.route('/api', itemsRoutes);
app.route('/api', aiRoutes);
app.route('/api', imageRoutes);
app.route('/api', ttsRoutes);
app.route('/api', comparisonsRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// Serve static files from dist/ (built frontend)
const distDir = resolve(__dirname, '../../dist');
app.use('/*', serveStatic({ root: distDir }));

// SPA fallback — serve index.html for all non-API, non-file routes
app.get('*', serveStatic({ root: distDir, path: 'index.html' }));

// Prevent server from crashing on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

console.log(`DictProp server starting on port ${env.PORT}...`);

const server = serve({
  fetch: app.fetch,
  port: env.PORT,
});

console.log(`Server running at http://localhost:${env.PORT}`);

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, closing HTTP server...`);
  server.close((error) => {
    if (error) {
      console.error('Failed to close HTTP server:', error);
      process.exitCode = 1;
    }
    process.exit();
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

// Migrate inline base64 images → item_images in the BACKGROUND, after the port is open.
// Runs in event-loop-yielding chunks so health/reads stay responsive; resumes each boot
// until no inline images remain. A short delay lets the listener bind first.
setTimeout(() => {
  migrateInlineImages()
    .then(() => console.log('[migrate] item_images pass complete'))
    .catch((e) => console.error('[migrate] item_images failed (will retry next boot):', e));
}, 500);

// Backfill TTS audio + word timings for every saved sentence in the BACKGROUND, server-side, so the
// client never needs to stay open. Idempotent + resumable (skips clips that are already complete).
// Delayed so boot + the image migration settle first; low concurrency keeps the 1-vCPU box responsive.
setTimeout(() => {
  runBackfill().catch((e) => console.error('[tts] startup backfill failed:', e?.message));
}, 20_000);
