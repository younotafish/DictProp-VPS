import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-auth-gate-test-'));
process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
delete process.env.DEV_AUTH_BYPASS;

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
