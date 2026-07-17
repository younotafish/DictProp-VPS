import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import { proxyFetch } from './proxy-fetch.js';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

let cachedJwks: { value: JSONWebKeySet; expiresAt: number } | null = null;

export interface GoogleIdentity extends JWTPayload {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  email_verified: true;
}

function cacheMaxAge(header: string | null): number {
  const seconds = Number(header?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60 * 60 * 1000;
}

async function loadGoogleJwks(forceRefresh = false): Promise<JSONWebKeySet> {
  if (!forceRefresh && cachedJwks && cachedJwks.expiresAt > Date.now()) return cachedJwks.value;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await proxyFetch(GOOGLE_JWKS_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Google signing keys unavailable: ${response.status}`);
  const value = await response.json() as JSONWebKeySet;
  if (!value || !Array.isArray(value.keys) || value.keys.length === 0) {
    throw new Error('Google signing keys response is invalid');
  }
  cachedJwks = { value, expiresAt: Date.now() + cacheMaxAge(response.headers.get('cache-control')) };
  return value;
}

export async function verifyGoogleIdTokenWithJwks(
  idToken: string,
  audience: string,
  jwks: JSONWebKeySet,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    algorithms: ['RS256'],
    audience,
    issuer: GOOGLE_ISSUERS,
  });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 ||
      typeof payload.email !== 'string' || payload.email.length === 0 ||
      payload.email_verified !== true ||
      (payload.name !== undefined && typeof payload.name !== 'string') ||
      (payload.picture !== undefined && typeof payload.picture !== 'string')) {
    throw new Error('Google identity claims are invalid');
  }
  return payload as GoogleIdentity;
}

export async function verifyGoogleIdToken(idToken: string, audience: string): Promise<GoogleIdentity> {
  const firstKeys = await loadGoogleJwks();
  try {
    return await verifyGoogleIdTokenWithJwks(idToken, audience, firstKeys);
  } catch (error) {
    // Google rotates keys. Refresh once before treating a signature failure as invalid.
    const refreshedKeys = await loadGoogleJwks(true);
    try {
      return await verifyGoogleIdTokenWithJwks(idToken, audience, refreshedKeys);
    } catch {
      throw error;
    }
  }
}
