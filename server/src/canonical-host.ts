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
