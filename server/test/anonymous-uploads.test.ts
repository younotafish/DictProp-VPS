import assert from 'node:assert/strict';
import test from 'node:test';

// The real session gate: no DEV_AUTH_BYPASS.
process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';

const { createApp } = await import('../src/app.js');
const app = createApp({ logging: false, serveStaticFiles: false });

test('an anonymous upload without a declared length is refused before any of it is read', async () => {
  for (const [method, path] of [['POST', '/api/import'], ['POST', '/api/transcribe'], ['PUT', '/api/items'], ['PUT', '/api/items/x/image']]) {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1 << 20));
      },
    });
    const response = await app.request(path, { method, body: endless, duplex: 'half' } as RequestInit);
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'Not authenticated' });
    // A stream fills its queue with one chunk before anyone reads it.
    assert.ok(pulled <= 1, `${method} ${path} pulled ${pulled} MB`);
  }
});
