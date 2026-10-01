import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-www-redirect-test-'));
process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
process.env.DEV_AUTH_BYPASS = '0';
process.env.PUBLIC_ORIGIN = '';

const { createApp } = await import('../src/app.js');
const app = createApp({ logging: false, serveStaticFiles: false });

// Caddy passes the visitor's Host through and adds X-Forwarded-Host.
const viaCaddy = (path: string, host: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  app.request(`http://${host}${path}`, {
    ...init,
    headers: { Host: host, 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https', ...init.headers },
  });

test('every www request is sent to the same path and query on the apex', async () => {
  for (const path of ['/', '/notebook?q=bank&tab=2', '/api/items?since=5', '/api/auth/login?returnTo=%2Flake-loop-26%2F']) {
    const response = await viaCaddy(path, 'www.dictprop.online');
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get('location'), `https://dictprop.online${path}`);
  }
  // 308 keeps the method and body, so a write is repeated on the apex rather than lost.
  const write = await viaCaddy('/api/items', 'www.dictprop.online', { method: 'PUT', body: '[]' });
  assert.equal(write.status, 308);
  assert.equal(write.headers.get('location'), 'https://dictprop.online/api/items');
});

test('the forwarded host decides, and a port on it does not matter', async () => {
  const response = await app.request('http://dictprop.online/about', {
    headers: { Host: 'dictprop.online', 'X-Forwarded-Host': 'WWW.dictprop.online:443' },
  });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://dictprop.online/about');
});

test('the trip gate on www sends the visitor to the page they asked for on the apex', async () => {
  const gate = (forwardedUri?: string) => viaCaddy('/api/auth/gate?returnTo=/lake-loop-26/', 'www.dictprop.online', {
    headers: forwardedUri ? { 'X-Forwarded-Uri': forwardedUri, 'X-Forwarded-Method': 'GET' } : {},
  });
  let response = await gate('/lake-loop-26/day/2?photo=3');
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://dictprop.online/lake-loop-26/day/2?photo=3');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');

  // Inside handle_path the trip prefix is gone from the forwarded URI; the trip root is the way back then.
  for (const forwardedUri of ['/day/2', undefined, 'https://evil.example/lake-loop-26/']) {
    response = await gate(forwardedUri);
    assert.equal(response.status, 308, String(forwardedUri));
    assert.equal(response.headers.get('location'), 'https://dictprop.online/lake-loop-26/');
  }
});

test('the apex and local development hosts are never redirected', async () => {
  for (const host of ['dictprop.online', 'localhost:3000', '127.0.0.1:3001', 'www.example.com']) {
    const response = await viaCaddy('/api/health', host);
    assert.notEqual(response.status, 308, host);
    assert.equal(response.headers.get('location'), null);
  }
  const gate = await viaCaddy('/api/auth/gate?returnTo=/lake-loop-26/', 'dictprop.online');
  assert.equal(gate.status, 302);
  assert.equal(gate.headers.get('location'), '/api/auth/login?returnTo=%2Flake-loop-26%2F');
});
