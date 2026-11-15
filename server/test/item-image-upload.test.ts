import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { getItemImageBinary, upsertItemImageBinary } = await import('../src/db.js');
const { DEV_AUTH_USER } = await import('../src/middleware/auth.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const upload = (id: string, body: Buffer, type = 'image/png') =>
  app.request(`/api/items/${encodeURIComponent(id)}/image`, { method: 'PUT', headers: { 'Content-Type': type }, body });

test('an image upload says why it was refused', async () => {
  const cases: Array<[string, Buffer, string, number, string]> = [
    ['a'.repeat(201), png, 'image/png', 400, 'Invalid item id'],
    ['empty-upload', Buffer.alloc(0), 'image/png', 400, 'Image is empty'],
    ['svg-upload', png, 'image/svg+xml', 415, 'Unsupported image type'],
    ['mislabeled-upload', png, 'image/jpeg', 415, 'Image is not a valid image/jpeg'],
    ['garbage-upload', Buffer.from('not an image'), 'image/png', 415, 'Image is not a valid image/png'],
  ];
  for (const [id, body, type, status, error] of cases) {
    const response = await upload(id, body, type);
    assert.equal(response.status, status, id);
    assert.deepEqual(await response.json(), { error }, id);
  }

  assert.equal(upsertItemImageBinary('someone-elses-image', png, 'image/png', 'someone-else'), true);
  const taken = await upload('someone-elses-image', png);
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: 'Image id belongs to another user' });
  assert.equal(getItemImageBinary('someone-elses-image', DEV_AUTH_USER.id), null);

  const stored = await upload('uploaded-image', png);
  assert.equal(stored.status, 200);
  assert.deepEqual(await stored.json(), { ok: true });
  assert.deepEqual(getItemImageBinary('uploaded-image', DEV_AUTH_USER.id)?.data, png);
});

test('a missing image is a JSON 404, like every other API miss', async () => {
  for (const path of ['/api/items/no-such-item/image', `/api/sentence-enrichments/${'0'.repeat(64)}/image`]) {
    const response = await app.request(path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'Not found' }, path);
  }
});
