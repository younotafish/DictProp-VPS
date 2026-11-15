import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { bytesToBase64, dataUriToBlob } from '../../services/dataUri.js';

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

test('bytesToBase64 encodes in chunks to the same text as a byte-by-byte encoding', () => {
  // Two full chunks and an odd remainder, so the padding and the chunk seams are both covered.
  const bytes = new Uint8Array(randomBytes(0x8000 * 2 + 3));
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(bytesToBase64(bytes), btoa(bytes.reduce((text, byte) => text + String.fromCharCode(byte), '')));
  assert.equal(bytesToBase64(new Uint8Array()), '');
  assert.equal(bytesToBase64(new Uint8Array([0xff])), '/w==');
});
