import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OfflineImage } from '../../components/OfflineImage.tsx';
import { saveImage } from '../../services/imageStore.ts';

const render = (props: Parameters<typeof OfflineImage>[0]) => renderToStaticMarkup(createElement(OfflineImage, props));
const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

test('a data URI or an authenticated /api/ URL is shown as it is', () => {
  assert.match(render({ src: PIXEL, alt: 'cat', className: 'w-full' }), /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="cat" class="w-full"/);
  assert.match(render({ src: '/api/items/x/image', itemId: 'x', alt: 'cat' }), /<img src="\/api\/items\/x\/image"/);
});

test('a server marker shows the picture in memory for its version on the first frame, and otherwise waits for it', () => {
  const url = saveImage('offline-image-card', PIXEL, 'v3');
  assert.match(render({ src: 'server:has_image:v3', itemId: 'offline-image-card', alt: 'cat' }), new RegExp(`<img src="${url}"`));
  const stale = render({ src: 'server:has_image:v4', itemId: 'offline-image-card', alt: 'cat', className: 'h-48' });
  assert.doesNotMatch(stale, /<img/);
  assert.match(stale, /animate-spin/);
});

test('with nothing to load, the placeholder says so instead of showing an old picture', () => {
  assert.match(render({ alt: 'cat', className: 'h-48' }), /No Image/);
});
