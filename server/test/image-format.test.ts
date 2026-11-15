import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectImageMimeType, hasImageSignature, isSupportedImageMime, isValidImage, parseImageDataUri, SUPPORTED_IMAGE_MIMES,
} from '../src/image-format.js';
import { png } from './support/fs.js';

test('image MIME is derived from bytes instead of an upstream label', () => {
  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');

  assert.equal(detectImageMimeType(jpeg), 'image/jpeg');
  assert.equal(hasImageSignature(jpeg, 'image/jpeg'), true);
  assert.equal(hasImageSignature(jpeg, 'image/png'), false);
});

test('unsupported bytes are never accepted as an image', () => {
  assert.equal(detectImageMimeType(Buffer.from('<html>not an image</html>')), null);
});

test('only the five raster types are supported, and only bytes of the declared type are a valid image', () => {
  assert.deepEqual(SUPPORTED_IMAGE_MIMES, ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  for (const mime of ['image/svg+xml', 'image/jpg', 'IMAGE/PNG', 'text/html', '', undefined]) {
    assert.equal(isSupportedImageMime(mime), false, String(mime));
  }
  const bytes = png('valid');
  assert.equal(isValidImage(bytes, 'image/png'), true);
  assert.equal(isValidImage(bytes, 'image/jpeg'), false);
  assert.equal(isValidImage(bytes, 'image/svg+xml'), false);
  assert.equal(isValidImage(Buffer.alloc(0), 'image/png'), false);
});

test('a data URI parses only when it is base64 of a supported type', () => {
  const bytes = png('uri');
  assert.deepEqual(parseImageDataUri(`data:image/png;base64,${bytes.toString('base64')}`), { mimeType: 'image/png', data: bytes });
  for (const uri of [
    `data:image/svg+xml;base64,${bytes.toString('base64')}`,
    `data:image/PNG;base64,${bytes.toString('base64')}`,
    `data:image/png,${bytes.toString('base64')}`,
    'data:image/png;base64,not*base64',
    'https://example.com/image.png',
  ]) {
    assert.equal(parseImageDataUri(uri), null, uri);
  }
});
