import assert from 'node:assert/strict';
import test from 'node:test';
import { detectImageMimeType, hasImageSignature } from '../src/image-format.js';

test('image MIME is derived from bytes instead of an upstream label', () => {
  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');

  assert.equal(detectImageMimeType(jpeg), 'image/jpeg');
  assert.equal(hasImageSignature(jpeg, 'image/jpeg'), true);
  assert.equal(hasImageSignature(jpeg, 'image/png'), false);
});

test('unsupported bytes are never accepted as an image', () => {
  assert.equal(detectImageMimeType(Buffer.from('<html>not an image</html>')), null);
});
