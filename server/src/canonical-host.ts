import { env } from './env.js';

// dictprop.online is the one canonical origin: Google returns every sign-in to it, so the sign-in cookies a
// www.dictprop.online login set never came back and the sign-in failed. www requests are sent to the apex.
export const CANONICAL_ORIGIN = 'https://dictprop.online';
const WWW_HOST = `www.${new URL(CANONICAL_ORIGIN).hostname}`;

type HeaderReader = { header(name: string): string | undefined };

/**
 * The host the visitor asked for, as Caddy forwards it: the first one listed, lowercased, and without its port
 * unless `keepPort`. `fallback` stands in for a request without a Host header.
 */
export function forwardedHost(req: HeaderReader, { keepPort = false, fallback = '' } = {}): string {
  const host = (req.header('x-forwarded-host') || req.header('host') || fallback).split(',')[0].trim().toLowerCase();
  return keepPort ? host : host.replace(/:\d+$/, '');
}

/** The scheme the visitor used, as Caddy forwards it. */
export const forwardedProto = (req: HeaderReader): string => req.header('x-forwarded-proto') || 'http';

export const isWwwHost = (host: string): boolean => host === WWW_HOST;

/** A local development server's origin, when the request came to one; a request without a Host header did. */
function localDevOrigin(req: HeaderReader): string | undefined {
  const host = forwardedHost(req, { keepPort: true, fallback: 'localhost:3001' });
  return forwardedProto(req) === 'http' && /^(?:localhost|127\.0\.0\.1):(?:3000|3001|3002)$/.test(host)
    ? `http://${host}`
    : undefined;
}

/** The origin sign-in runs on, where Google sends it back: PUBLIC_ORIGIN's when set, else a local server's, else the canonical one. */
export function signInOrigin(req: HeaderReader): string {
  return env.PUBLIC_ORIGIN || localDevOrigin(req) || CANONICAL_ORIGIN;
}

/** Cookies are Secure whenever sign-in runs on https, even if a proxy leaves out the header. */
export const wantsSecureCookies = (req: HeaderReader): boolean =>
  forwardedProto(req) === 'https' || signInOrigin(req).startsWith('https://');
