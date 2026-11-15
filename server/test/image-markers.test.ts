import assert from 'node:assert/strict';
import test from 'node:test';
import { getServerImageVersion, SERVER_IMAGE_MARKER, serverImageMarker } from '../src/shared/image-markers.js';

test('a server image marker names the content version after the marker', () => {
  assert.equal(serverImageMarker('0123456789abcdef0123'), 'server:has_image:0123456789abcdef0123');
  assert.equal(getServerImageVersion(serverImageMarker('0123456789abcdef0123')), '0123456789abcdef0123');
  for (const url of [undefined, '', SERVER_IMAGE_MARKER, 'idb:stored', 'data:image/png;base64,AAAA', 'server:has_imagex:1']) {
    assert.equal(getServerImageVersion(url), undefined, String(url));
  }
});
