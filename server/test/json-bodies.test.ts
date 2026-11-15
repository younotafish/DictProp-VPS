import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { readJsonArray, readJsonObject } from '../src/middleware/json-body.js';

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const app = createApp({ logging: false, serveStaticFiles: false });

test('the JSON body readers return the body only when it has the expected shape', async () => {
  const readers = new Hono();
  readers.post('/object', async c => c.json({ body: await readJsonObject(c) }));
  readers.post('/array', async c => c.json({ body: await readJsonArray(c) }));
  const read = async (path: string, body: string) =>
    (await (await readers.request(path, { method: 'POST', body })).json() as { body: unknown }).body;

  assert.deepEqual(await read('/object', '{"a":1}'), { a: 1 });
  assert.deepEqual(await read('/array', '[1]'), [1]);
  for (const body of ['{not json', 'null', '"text"', '3', '[1]']) assert.equal(await read('/object', body), null, body);
  for (const body of ['{not json', 'null', '{"a":1}', '"text"']) assert.equal(await read('/array', body), null, body);
});

test('a JSON route answers malformed JSON, null and a body of the wrong shape with its own 400', async () => {
  const routes = [
    ['PUT', '/api/items', 'Expected array of items', '{}'],
    ['POST', '/api/import', 'Expected array of items', '{}'],
    ['POST', '/api/reviews/apply', 'Invalid review mutation', '[]'],
    ['POST', '/api/sentence-enrichments/lookup', 'Expected a non-empty sentence', '[]'],
    ['PUT', '/api/comparisons', 'key, words[], and data are required', '[]'],
  ] as const;
  for (const [method, path, error, wrongShape] of routes) {
    for (const body of ['{not json', 'null', wrongShape]) {
      const response = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 400, `${method} ${path} ${body}`);
      assert.deepEqual(await response.json(), { error }, `${method} ${path} ${body}`);
    }
  }
});
