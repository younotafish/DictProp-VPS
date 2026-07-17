import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { randomUUID } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { requireAuth, type AuthVariables } from './middleware/auth.js';
import { createConcurrencyLimit, createRateLimit } from './middleware/runtime.js';
import { isDatabaseReady } from './db.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { comparisonsRoutes } from './routes/comparisons.js';
import { imageRoutes } from './routes/images.js';
import { itemsRoutes } from './routes/items.js';
import { ttsRoutes } from './routes/tts.js';

export interface AppOptions {
  logging?: boolean;
  serveStaticFiles?: boolean;
}

const ALLOWED_ORIGINS = [
  'https://dictprop.online',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
];
const ALLOWED_ORIGIN_SET = new Set(ALLOWED_ORIGINS);

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.onError((error, c) => {
    const requestId = c.get('requestId') || 'unknown';
    console.error(JSON.stringify({
      level: 'error',
      requestId,
      method: c.req.method,
      path: c.req.path,
      message: error.message || 'Internal server error',
    }));
    return c.json({ error: 'Internal server error', requestId }, 500);
  });

  app.use('*', async (c, next) => {
    const supplied = c.req.header('x-request-id');
    const requestId = supplied && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    await next();
  });
  if (options.logging !== false) app.use('*', logger());
  app.use('*', secureHeaders({
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'", 'https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co'],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
      manifestSrc: ["'self'"],
      mediaSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      workerSrc: ["'self'", 'blob:'],
    },
  }));
  app.use('*', cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }));
  app.use('*', compress({ threshold: 1024 }));
  app.use('/api/*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const origin = c.req.header('origin');
    const fetchSite = c.req.header('sec-fetch-site');
    if (fetchSite === 'cross-site' || (origin && !ALLOWED_ORIGIN_SET.has(origin))) {
      return c.json({ error: 'Cross-origin mutation rejected' }, 403);
    }
    return next();
  });

  const smallJsonLimit = bodyLimit({
    maxSize: 512 * 1024,
    onError: c => c.json({ error: 'Request body too large' }, 413),
  });
  app.use('/api/analyze', smallJsonLimit);
  app.use('/api/compare', smallJsonLimit);
  app.use('/api/extract-vocabulary', smallJsonLimit);
  app.use('/api/generate-image', smallJsonLimit);
  app.use('/api/image-backfill', smallJsonLimit);
  app.use('/api/projects', smallJsonLimit);
  app.use('/api/projects/*', smallJsonLimit);
  app.use('/api/comparisons', smallJsonLimit);
  app.use('/api/comparisons/*', smallJsonLimit);
  app.use('/api/tts/*', smallJsonLimit);
  app.use('/api/reviews', smallJsonLimit);
  app.use('/api/reviews/*', smallJsonLimit);
  app.use('/api/transcribe', bodyLimit({
    maxSize: 25 * 1024 * 1024,
    onError: c => c.json({ error: 'Audio upload too large' }, 413),
  }));
  app.use('/api/items', bodyLimit({
    maxSize: 20 * 1024 * 1024,
    onError: c => c.json({ error: 'Item batch is too large' }, 413),
  }));
  app.use('/api/items/*', bodyLimit({
    maxSize: 11 * 1024 * 1024,
    onError: c => c.json({ error: 'Item request is too large' }, 413),
  }));
  app.use('/api/import', bodyLimit({
    maxSize: 25 * 1024 * 1024,
    onError: c => c.json({ error: 'Import is too large' }, 413),
  }));

  app.route('/api/auth', authRoutes);
  app.use('/api/*', requireAuth);
  const textAiRateLimit = createRateLimit(30, 5 * 60 * 1000);
  const textAiConcurrency = createConcurrencyLimit(2);
  for (const path of ['/api/analyze', '/api/extract-vocabulary', '/api/compare']) {
    app.use(path, textAiRateLimit);
    app.use(path, textAiConcurrency);
  }
  // The image-generation module owns a single FIFO queue, so concurrent sense images wait instead
  // of receiving a 503. This limit controls abuse without breaking a few multi-sense searches.
  app.use('/api/generate-image', createRateLimit(60, 5 * 60 * 1000));
  app.use('/api/transcribe', createRateLimit(30, 5 * 60 * 1000));
  app.use('/api/transcribe', createConcurrencyLimit(2));
  app.use('/api/import', createRateLimit(5, 60 * 60 * 1000));
  app.use('/api/import', createConcurrencyLimit(1));
  app.route('/api', itemsRoutes);
  app.route('/api', aiRoutes);
  app.route('/api', imageRoutes);
  app.route('/api', ttsRoutes);
  app.route('/api', comparisonsRoutes);
  app.get('/api/health', c => {
    const database = isDatabaseReady();
    return c.json(
      { status: database ? 'ok' : 'unavailable', database: database ? 'ok' : 'unavailable', timestamp: Date.now() },
      database ? 200 : 503,
    );
  });

  if (options.serveStaticFiles !== false) {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const distDir = resolve(currentDir, '../../dist');
    app.use('/*', serveStatic({
      root: distDir,
      onFound: (_path, c) => {
        if (c.req.path.startsWith('/assets/')) {
          c.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          c.header('Cache-Control', 'no-cache');
        }
      },
    }));
    app.get('*', serveStatic({
      root: distDir,
      path: 'index.html',
      onFound: (_path, c) => c.header('Cache-Control', 'no-cache'),
    }));
  }

  return app;
}

export type DictPropApp = ReturnType<typeof createApp>;
