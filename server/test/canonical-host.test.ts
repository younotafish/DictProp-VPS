import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_ORIGIN, forwardedHost, forwardedProto, isWwwHost, signInOrigin, wantsSecureCookies } from '../src/canonical-host.js';

const headers = (values: Record<string, string>) => ({ header: (name: string) => values[name] });

test('the forwarded host is the first one Caddy lists, lowercased, with its port only when asked for', () => {
  const req = headers({ 'x-forwarded-host': 'WWW.DictProp.online:443, proxy.internal', host: 'localhost:3000' });
  assert.equal(forwardedHost(req), 'www.dictprop.online');
  assert.equal(forwardedHost(req, { keepPort: true }), 'www.dictprop.online:443');
  assert.equal(forwardedHost(headers({ host: '127.0.0.1:3001' }), { keepPort: true }), '127.0.0.1:3001');
  assert.equal(forwardedHost(headers({})), '');
  assert.equal(forwardedHost(headers({}), { keepPort: true, fallback: 'localhost:3001' }), 'localhost:3001');
});

test('the forwarded scheme defaults to http, and only the www host of the canonical origin is www', () => {
  assert.equal(forwardedProto(headers({})), 'http');
  assert.equal(forwardedProto(headers({ 'x-forwarded-proto': 'https' })), 'https');
  assert.equal(CANONICAL_ORIGIN, 'https://dictprop.online');
  assert.equal(isWwwHost('www.dictprop.online'), true);
  assert.equal(isWwwHost('dictprop.online'), false);
  assert.equal(isWwwHost('www.example.com'), false);
});

test('sign-in runs on a local server reached over plain http, and on the canonical origin otherwise', () => {
  for (const host of ['localhost:3000', 'localhost:3001', 'localhost:3002', '127.0.0.1:3000']) {
    assert.equal(signInOrigin(headers({ host })), `http://${host}`, host);
    assert.equal(wantsSecureCookies(headers({ host })), false, host);
  }
  // A request without a Host header came to the local API server.
  assert.equal(signInOrigin(headers({})), 'http://localhost:3001');
  const elsewhere: Array<Record<string, string>> = [
    { host: 'dictprop.online' },
    { host: 'localhost:5173' },
    { host: 'localhost:3000', 'x-forwarded-proto': 'https' },
    { 'x-forwarded-host': 'dictprop.online', host: 'localhost:3000' },
  ];
  for (const request of elsewhere) {
    assert.equal(signInOrigin(headers(request)), CANONICAL_ORIGIN, JSON.stringify(request));
    // Secure even when a proxy leaves out the scheme, since the round trip ends on https://dictprop.online.
    assert.equal(wantsSecureCookies(headers(request)), true, JSON.stringify(request));
  }
});
