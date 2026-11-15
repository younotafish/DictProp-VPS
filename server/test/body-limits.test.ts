import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const MB = 1024 * 1024;
// The limits decide from the declared Content-Length, so a tiny body with a larger declared length tests them.
const LIMITS: Array<[string, string, number, string]> = [
  ['POST', '/api/analyze', 512 * 1024, 'Request body too large'],
  ['POST', '/api/compare', 512 * 1024, 'Request body too large'],
  ['POST', '/api/extract-vocabulary', 512 * 1024, 'Request body too large'],
  ['PUT', '/api/comparisons', 512 * 1024, 'Request body too large'],
  ['POST', '/api/sentence-enrichments/lookup', 512 * 1024, 'Request body too large'],
  ['POST', '/api/tts/generate', 512 * 1024, 'Request body too large'],
  ['POST', '/api/reviews/apply', 512 * 1024, 'Request body too large'],
  ['POST', '/api/reviews/some-review/undo', 512 * 1024, 'Request body too large'],
  ['POST', '/api/transcribe', 25 * MB, 'Audio upload too large'],
  ['POST', '/api/import', 25 * MB, 'Import is too large'],
  ['PUT', '/api/items', 20 * MB, 'Item batch is too large'],
  ['PUT', '/api/items/some-item/image', 11 * MB, 'Item request is too large'],
];

const declaring = (method: string, length: number): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json', 'Content-Length': String(length) }, body: '{}',
});

test('each body-reading route has exactly its own limit', async () => {
  for (const [method, path, cap, error] of LIMITS) {
    const over = await app.request(path, declaring(method, cap + 1));
    assert.equal(over.status, 413, `${method} ${path} over its cap`);
    assert.deepEqual(await over.json(), { error }, `${method} ${path}`);
    const at = await app.request(path, declaring(method, cap));
    assert.notEqual(at.status, 413, `${method} ${path} at its cap`);
  }
});
