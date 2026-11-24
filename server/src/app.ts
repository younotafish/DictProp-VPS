import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { randomUUID } from 'crypto';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { requireAuth, type AppEnv } from './middleware/auth.js';
import { createClientRateLimit, createConcurrencyLimit, createRateLimit } from './middleware/rate-limit.js';
import { CANONICAL_ORIGIN, forwardedHost, isWwwHost } from './canonical-host.js';
import { isDatabaseReady } from './db.js';
import { env } from './env.js';
import { ConflictError } from './errors.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { comparisonsRoutes } from './routes/comparisons.js';
import { essaysRoutes } from './routes/essays.js';
import { importRoutes } from './routes/import.js';
import { itemImageRoutes } from './routes/item-images.js';
import { itemsRoutes } from './routes/items.js';
import { createReviewRoutes } from './routes/reviews.js';
import { sentenceEnrichmentRoutes } from './routes/sentence-enrichments.js';
import { studyEventsRoutes } from './routes/study-events.js';
import { createThemeRoutes } from './routes/themes.js';
import { ttsRoutes } from './routes/tts.js';
import { themeSweep as serverThemeSweep, type ThemeSweep } from './themes/sweep.js';

export interface AppOptions {
  logging?: boolean;
  serveStaticFiles?: boolean;
  /** The built client; defaults to the repository's dist/. */
  staticDir?: string;
  aiRouter?: Hono;
  /** The theme sweep GET /api/themes reports and item writes nudge; defaults to the server's own. */
  themeSweep?: ThemeSweep;
}

// Local development origins. Production is served same-origin behind Caddy and never needs them.
const LOCAL_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
];
// A PUBLIC_ORIGIN other than the canonical one is where sign-in returns, so its pages must be able to save too.
const ALLOWED_ORIGINS = [...new Set([
  CANONICAL_ORIGIN,
  ...(env.PUBLIC_ORIGIN ? [env.PUBLIC_ORIGIN] : []),
  ...(env.IS_PRODUCTION ? [] : LOCAL_DEV_ORIGINS),
])];
const ALLOWED_ORIGIN_SET = new Set(ALLOWED_ORIGINS);
// Query strings can carry OAuth codes and state, so request logs keep only the path.
const logWithoutQuery = (message: string, ...rest: string[]) =>
  console.log(message.replace(/\?\S*/, ''), ...rest);

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof ConflictError) return c.json({ error: error.message }, 409);
    const requestId = c.get('requestId') || 'unknown';
    // One JSON line, stack included: the deploy log's public excerpt drops every line that names a requestId.
    console.error(JSON.stringify({
      level: 'error',
      requestId,
      method: c.req.method,
      path: c.req.path,
      message: error.message || 'Internal server error',
      stack: error.stack,
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
  if (options.logging !== false) app.use('*', logger(logWithoutQuery));
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
  // The gate answers Caddy's forward_auth subrequest, whose path isn't the visitor's: it redirects www itself.
  app.use('*', async (c, next) => {
    if (c.req.path === '/api/auth/gate' || !isWwwHost(forwardedHost(c.req))) return next();
    const url = new URL(c.req.url);
    return c.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 308);
  });
  app.use('*', cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
    // The client only sends Content-Type. A fixed list also keeps hono from splitting an attacker-sized
    // Access-Control-Request-Headers value with a backtracking regex before auth (GHSA-8j4g-w8fx-2239).
    allowHeaders: ['Content-Type'],
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

  // Sign-in runs before there is a user to key a limit on, so these count per client address.
  app.use('/api/auth/login', createClientRateLimit(20, 60_000));
  app.use('/api/auth/callback', createClientRateLimit(10, 60_000));
  app.route('/api/auth', authRoutes);
  // An unknown sign-in path, or a known one with the wrong method, is a 404 here, before the session gate.
  app.all('/api/auth/*', c => c.json({ error: 'Not found' }, 404));
  app.get('/api/health', c => {
    const database = isDatabaseReady();
    return c.json(
      { status: database ? 'ok' : 'unavailable', database: database ? 'ok' : 'unavailable', timestamp: Date.now() },
      database ? 200 : 503,
    );
  });
  // Everything after this needs the owner's session.
  app.use('/api/*', requireAuth);
  // Body limits run after the session gate, so an anonymous upload is refused before any of it is read.
  // One limit per route that reads a body, and no two patterns overlap: a trailing /* also matches the bare path.
  const limitBody = (maxSize: number, error: string) => bodyLimit({ maxSize, onError: c => c.json({ error }, 413) });
  const smallJsonLimit = limitBody(512 * 1024, 'Request body too large');
  for (const path of [
    '/api/analyze', '/api/compare', '/api/extract-vocabulary', '/api/comparisons',
    '/api/sentence-enrichments/*', '/api/tts/*', '/api/reviews/*', '/api/study-events',
  ]) {
    app.use(path, smallJsonLimit);
  }
  app.use('/api/transcribe', limitBody(25 * 1024 * 1024, 'Audio upload too large'));
  app.use('/api/import', limitBody(25 * 1024 * 1024, 'Import is too large'));
  app.use('/api/items', limitBody(20 * 1024 * 1024, 'Item batch is too large'));
  app.use('/api/items/:id/image', limitBody(11 * 1024 * 1024, 'Item request is too large'));
  app.use('/api/import', createRateLimit(5, 60 * 60 * 1000));
  app.use('/api/study-events', createRateLimit(120, 60_000));
  app.use('/api/import', createConcurrencyLimit(1, 'Another data import is already running. Try again shortly.'));
  // A save or an import can bring items the theme sweep hasn't labelled: its count goes stale, and it runs once the
  // writes stop. So can a review whose seed brings its sentence with it, which tells the sweep from its own route
  // (routes/reviews.ts), the one place that knows the review carried a seed and was applied.
  const themeSweep = options.themeSweep ?? serverThemeSweep;
  for (const [method, path] of [['PUT', '/api/items'], ['POST', '/api/import']] as const) {
    app.use(path, async (c, next) => {
      await next();
      if (c.req.method === method && c.res.ok) themeSweep.noteItemWrite(c.get('user').id);
    });
  }
  app.route('/api', sentenceEnrichmentRoutes);
  app.route('/api', itemsRoutes);
  app.route('/api', itemImageRoutes);
  app.route('/api', importRoutes);
  app.route('/api', createReviewRoutes(themeSweep));
  app.route('/api', studyEventsRoutes);
  app.route('/api', essaysRoutes);
  app.route('/api', options.aiRouter ?? aiRoutes);
  app.route('/api', ttsRoutes);
  app.route('/api', comparisonsRoutes);
  app.route('/api', createThemeRoutes(themeSweep));
  // An unknown API path is an error, not a page: without this the static fallback answers it with the app shell.
  app.all('/api/*', c => c.json({ error: 'Not found' }, 404));

  if (options.serveStaticFiles !== false) {
    const distDir = options.staticDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
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
    // A build file that isn't here belongs to a replaced build. Answer 404 rather than the app shell, so the
    // page asking for it fails fast and reloads, and no cache stores HTML under a script's name.
    app.get('/assets/*', c => c.notFound());
    app.get('*', serveStatic({
      root: distDir,
      path: 'index.html',
      onFound: (_path, c) => c.header('Cache-Control', 'no-cache'),
    }));
  }

  return app;
}
