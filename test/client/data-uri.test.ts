import assert from 'node:assert/strict';
import test from 'node:test';
import { dataUriToBlob } from '../../services/dataUri.js';

test('dataUriToBlob decodes base64 without fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('fetch must not be called'); }) as typeof fetch;

  try {
    const blob = dataUriToBlob('data:image/png;base64,iVBORw0KGgo=');
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(
      [...new Uint8Array(await blob.arrayBuffer())],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dataUriToBlob decodes percent-encoded data', async () => {
  const blob = dataUriToBlob('data:text/plain;charset=utf-8,hello%20world');
  assert.equal(blob.type, 'text/plain');
  assert.equal(await blob.text(), 'hello world');
});

test('dataUriToBlob rejects malformed input', () => {
  assert.throws(() => dataUriToBlob('not-a-data-uri'), /Invalid data URI/);
});
