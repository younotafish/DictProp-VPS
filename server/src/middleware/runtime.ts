import type { Context, MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'http';
import { isIP } from 'net';
import type { AuthVariables } from './auth.js';
import { isPrivateNetworkAddress, parseIpv6 } from '../safe-url.js';

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

/**
 * The address a request came from. Behind Caddy the socket peer is the proxy (loopback, or the Docker bridge),
 * and only then is X-Forwarded-For trusted, and only its last entry: the one Caddy wrote. Earlier entries are
 * whatever the client sent. An IPv6 client is keyed by its /64, which one subscriber usually holds whole.
 */
export function clientAddress(c: Context): string {
  const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress;
  if (!peer) return 'unknown';
  let address = peer;
  if (isPrivateNetworkAddress(peer)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (forwarded && isIP(forwarded)) address = forwarded;
  }
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return mapped;
  const groups = isIP(address) === 6 ? parseIpv6(address) : null;
  return groups ? `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64` : address;
}

/**
 * A fixed-window limit per client address for routes that run before sign-in. It keeps at most `maxClients`
 * windows: windows are stored oldest first, so expired ones are dropped from the front, and when the map is
 * full the oldest live window goes too.
 */
export function createClientRateLimit(limit: number, windowMs: number, maxClients = 10_000): MiddlewareHandler {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const now = Date.now();
    const key = clientAddress(c);
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      windows.delete(key);
      for (const [address, entry] of windows) {
        if (entry.resetAt > now && windows.size < maxClients) break;
        windows.delete(address);
      }
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }
    if (window.count >= limit) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((window.resetAt - now) / 1000))));
      return c.json({ error: 'Too many sign-in attempts. Try again shortly.' }, 429);
    }
    window.count++;
    await next();
  };
}
