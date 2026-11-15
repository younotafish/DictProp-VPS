import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_ORIGIN, forwardedHost, forwardedProto, isWwwHost } from '../src/canonical-host.js';

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
