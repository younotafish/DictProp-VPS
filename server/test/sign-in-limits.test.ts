import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-sign-in-limits-test-'));
process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
process.env.DEV_AUTH_BYPASS = '0';
process.env.PUBLIC_ORIGIN = '';

const { createApp } = await import('../src/app.js');
const { clientAddress, createClientRateLimit } = await import('../src/middleware/runtime.js');

// @hono/node-server hands every handler the socket as env.incoming; Caddy is the peer in production.
const from = (remoteAddress?: string) => ({ incoming: { socket: { remoteAddress } } });

test('login allows 20 attempts a minute per client and callback 10, each counted on its own', async () => {
  const app = createApp({ logging: false, serveStaticFiles: false });
  const login = (peer: string) => app.request('https://dictprop.online/api/auth/login', {}, from(peer));
  const callback = (peer: string) => app.request('https://dictprop.online/api/auth/callback?code=c&state=s', {}, from(peer));

  for (let attempt = 0; attempt < 20; attempt++) assert.equal((await login('203.0.113.9')).status, 302);
  const limited = await login('203.0.113.9');
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, String(retryAfter));
  assert.equal((await login('203.0.113.10')).status, 302);

  // The callback has its own, lower budget: a refused state still counts against it.
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await callback('203.0.113.9')).status, 400);
  assert.equal((await callback('203.0.113.9')).status, 429);
  assert.equal((await callback('203.0.113.10')).status, 400);
});

test('behind Caddy the client is the last forwarded hop; anyone else cannot choose their address', async () => {
  const probe = new Hono().get('/', c => c.text(clientAddress(c)));
  const addressOf = async (peer: string | undefined, forwardedFor?: string) => (await probe.request('/', {
    headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {},
  }, from(peer))).text();

  assert.equal(await addressOf('203.0.113.9'), '203.0.113.9');
  // Caddy appends the address it saw; whatever the client put in front of it is ignored.
  assert.equal(await addressOf('127.0.0.1', '10.9.9.9, 198.51.100.20'), '198.51.100.20');
  assert.equal(await addressOf('172.18.0.1', '198.51.100.20'), '198.51.100.20'); // the Docker bridge
  assert.equal(await addressOf('::ffff:127.0.0.1', '198.51.100.20'), '198.51.100.20');
  assert.equal(await addressOf('127.0.0.1', 'not-an-address'), '127.0.0.1');
  // A public peer is the client itself, so its header is not trusted.
  assert.equal(await addressOf('198.51.100.7', '203.0.113.9'), '198.51.100.7');
  assert.equal(await addressOf('::ffff:198.51.100.7'), '198.51.100.7');
  // One IPv6 subscriber usually holds a whole /64, so it is one client.
  assert.equal(await addressOf('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(await addressOf('127.0.0.1', '2001:db8:1:2:ffff::1'), '2001:db8:1:2::/64');
  assert.equal(await addressOf(undefined), 'unknown');
});

test('the limiter forgets the oldest clients instead of growing without bound', async () => {
  const app = new Hono();
  app.use('*', createClientRateLimit(1, 60_000, 3));
  app.get('/', c => c.text('ok'));
  const hit = async (peer: string) => (await app.request('/', {}, from(peer))).status;

  for (const peer of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4', '198.51.100.5']) {
    assert.equal(await hit(peer), 200);
  }
  assert.equal(await hit('198.51.100.5'), 429); // still tracked
  assert.equal(await hit('198.51.100.1'), 200); // dropped to make room, so it starts over
});

test('a client is let back in when its window ends', async () => {
  const app = new Hono();
  app.use('*', createClientRateLimit(1, 50));
  app.get('/', c => c.text('ok'));
  const hit = async () => (await app.request('/', {}, from('198.51.100.1'))).status;
  assert.equal(await hit(), 200);
  assert.equal(await hit(), 429);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(await hit(), 200);
});
