import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseTransport, type Transport } from '../src/proxy-fetch.js';

// A machine exercises only the transport its environment picks when proxy-fetch.ts loads: curl and the proxy on the
// Mac, where a proxy is set, the direct path in CI and on the VPS. The choice itself is pinned here for both.
const CURL_THRESHOLD_BYTES = 32 * 1024;

test('through a proxy, only a string body of 32 KB or more, counted in bytes, goes through curl; without one, every request is direct', () => {
  const cases: Array<[string, RequestInit['body'], Transport]> = [
    ['no body', undefined, 'proxy'],
    ['a null body', null, 'proxy'],
    ['a string one byte short of 32 KB', 'x'.repeat(CURL_THRESHOLD_BYTES - 1), 'proxy'],
    ['a 32 KB string', 'x'.repeat(CURL_THRESHOLD_BYTES), 'curl'],
    // é is two bytes in UTF-8, so these strings have half as many characters as bytes.
    ['a multibyte string one byte short of 32 KB', `${'é'.repeat(CURL_THRESHOLD_BYTES / 2 - 1)}x`, 'proxy'],
    ['a multibyte string of 32 KB', 'é'.repeat(CURL_THRESHOLD_BYTES / 2), 'curl'],
    ['FormData', new FormData(), 'proxy'],
    ['a 32 KB Blob', new Blob(['x'.repeat(CURL_THRESHOLD_BYTES)]), 'proxy'],
    ['32 KB of bytes', new Uint8Array(CURL_THRESHOLD_BYTES), 'proxy'],
  ];
  for (const [label, body, proxied] of cases) {
    assert.equal(chooseTransport(true, body), proxied, `with a proxy: ${label}`);
    assert.equal(chooseTransport(false, body), 'direct', `without a proxy: ${label}`);
  }
});
