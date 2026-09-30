import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-auth-gate-test-'));
process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
// dotenv loads the repository's local development settings when env.ts is imported. An explicit
// false value keeps this auth test deterministic even when the developer has bypass enabled in .env.
process.env.DEV_AUTH_BYPASS = '0';
process.env.PUBLIC_ORIGIN = '';

const { authRoutes } = await import('../src/routes/auth.js');
const { createSession, createUserAndClaimItems } = await import('../src/db.js');

const app = new Hono();
app.route('/api/auth', authRoutes);

test('trip gate sends anonymous visitors through Google login', async () => {
  const response = await app.request(
    'https://dictprop.online/api/auth/gate?returnTo=%2Flake-loop-26%2F',
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get('location'),
    '/api/auth/login?returnTo=%2Flake-loop-26%2F',
  );
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('trip gate accepts an active owner session', async () => {
  const owner = createUserAndClaimItems({
    googleId: 'owner-google-id',
    email: 'owner@example.com',
    displayName: 'Owner',
    photoUrl: null,
  });
  const session = createSession(owner.id);

  const response = await app.request(
    'https://dictprop.online/api/auth/gate?returnTo=%2Flake-loop-26%2F',
    { headers: { Cookie: `session=${session.token}` } },
  );

  assert.equal(response.status, 204);
});

test('trip gate refuses off-site return targets', async () => {
  const response = await app.request(
    'https://dictprop.online/api/auth/gate?returnTo=https%3A%2F%2Fevil.example%2F',
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/api/auth/login?returnTo=%2F');
});

test('sign-in cookies are Secure unless the whole round trip is local http', async () => {
  const cookiesFor = async (url: string, headers: Record<string, string> = {}) => {
    const response = await app.request(url, { headers });
    assert.equal(response.status, 302);
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    return cookies;
  };

  // Behind a proxy that forgot x-forwarded-proto, the callback still runs on https://dictprop.online.
  for (const cookie of await cookiesFor('http://dictprop.online/api/auth/login', { Host: 'dictprop.online' })) {
    assert.match(cookie, /;\s*Secure/i);
  }
  for (const cookie of await cookiesFor('http://localhost:3000/api/auth/login', { Host: 'localhost:3000', 'X-Forwarded-Proto': 'https' })) {
    assert.match(cookie, /;\s*Secure/i);
  }
  // Local development signs in over plain http, where a Secure cookie would never come back.
  for (const cookie of await cookiesFor('http://localhost:3000/api/auth/login', { Host: 'localhost:3000' })) {
    assert.doesNotMatch(cookie, /Secure/i);
  }
});
