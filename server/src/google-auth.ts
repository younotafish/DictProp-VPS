import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import { createHash, randomBytes } from 'crypto';
import { proxyFetch, type FetchLike } from './proxy-fetch.js';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const JWKS_TIMEOUT_MS = 10_000;

/** Google's signing keys couldn't be had: a Google or network failure, not a bad token. */
export class GoogleKeysUnavailableError extends Error {
  name = 'GoogleKeysUnavailableError';
}

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

export interface GoogleIdTokenVerifierDependencies {
  fetch?: FetchLike;
  now?: () => number;
}

/** Verify Google id_tokens against Google's signing keys, which it caches for as long as Google says. */
export function createGoogleIdTokenVerifier({ fetch = proxyFetch, now = Date.now }: GoogleIdTokenVerifierDependencies = {}) {
  let cached: { value: JSONWebKeySet; expiresAt: number } | null = null;

  async function loadKeys(forceRefresh: boolean): Promise<JSONWebKeySet> {
    if (!forceRefresh && cached && cached.expiresAt > now()) return cached.value;
    // The deadline covers reading the keys, not only the response headers.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
    try {
      const response = await fetch(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new GoogleKeysUnavailableError(`Google signing keys unavailable: ${response.status}`);
      const value = await response.json() as JSONWebKeySet;
      if (!value || !Array.isArray(value.keys) || value.keys.length === 0) {
        throw new GoogleKeysUnavailableError('Google signing keys response is invalid');
      }
      cached = { value, expiresAt: now() + cacheMaxAge(response.headers.get('cache-control')) };
      return value;
    } catch (error) {
      if (error instanceof GoogleKeysUnavailableError) throw error;
      throw new GoogleKeysUnavailableError(`Google signing keys unavailable: ${error instanceof Error ? error.message : error}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function verify(idToken: string, audience: string): Promise<GoogleIdentity> {
    const firstKeys = await loadKeys(false);
    try {
      return await verifyGoogleIdTokenWithJwks(idToken, audience, firstKeys);
    } catch (error) {
      // Google rotates its keys, so a token signed with a key this copy lacks earns one fresh copy. Any other
      // failure, an expired token or a wrong audience, is the token's.
      if (!(error instanceof errors.JWKSNoMatchingKey) && !(error instanceof errors.JWSSignatureVerificationFailed)) {
        throw error;
      }
      const refreshedKeys = await loadKeys(true);
      try {
        return await verifyGoogleIdTokenWithJwks(idToken, audience, refreshedKeys);
      } catch {
        throw error;
      }
    }
  }

  return { verify };
}

export const verifyGoogleIdToken = createGoogleIdTokenVerifier().verify;

/**
 * A PKCE (S256) pair: the login sends the challenge, the token exchange the verifier, so an intercepted
 * authorization code is useless without the verifier kept in the sign-in cookie.
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
