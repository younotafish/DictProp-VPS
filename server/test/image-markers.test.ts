import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  getServerImageVersion, imageVersionFromContentHash, SERVER_IMAGE_MARKER, serverImageMarker,
} from '../src/shared/image-markers.js';

test('a server image marker names the content version after the marker', () => {
  assert.equal(serverImageMarker('0123456789abcdef0123'), 'server:has_image:0123456789abcdef0123');
  assert.equal(getServerImageVersion(serverImageMarker('0123456789abcdef0123')), '0123456789abcdef0123');
  for (const url of [undefined, '', SERVER_IMAGE_MARKER, 'idb:stored', 'data:image/png;base64,AAAA', 'server:has_imagex:1']) {
    assert.equal(getServerImageVersion(url), undefined, String(url));
  }
});

test('an image\'s content version is the first 20 hex digits of the SHA-256 of its bytes', () => {
  const sha256 = createHash('sha256').update('image bytes').digest('hex');
  assert.equal(sha256, 'de7030234493a8bea844dbe1d8676e68a2c1a4b014c721f0425a22b6df66faec');
  assert.equal(imageVersionFromContentHash(sha256), 'de7030234493a8bea844');
});
