import type { MiddlewareHandler } from 'hono';
import type { AuthVariables } from './auth.js';

type AppEnv = { Variables: AuthVariables };

export function createRateLimit(limit: number, windowMs: number): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const now = Date.now();
    const userId = c.get('user').id;
    const key = `${userId}:${c.req.path}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return c.json({ error: 'Too many requests. Try again shortly.' }, 429);
    }
    bucket.count++;
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    if (buckets.size > 1_000) {
      for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
    }
    await next();
  };
}

export function createConcurrencyLimit(maxConcurrent: number): MiddlewareHandler<AppEnv> {
  let active = 0;
  return async (c, next) => {
    if (active >= maxConcurrent) {
      c.header('Retry-After', '5');
      return c.json({ error: 'Another data import is already running. Try again shortly.' }, 503);
    }
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  };
}
