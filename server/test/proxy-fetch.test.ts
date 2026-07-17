import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { proxyFetch } from '../src/proxy-fetch.js';

test('proxyFetch handles large request bodies through its single transport boundary', async () => {
  const server = createServer((request, response) => {
    let length = 0;
    request.on('data', chunk => { length += chunk.length; });
    request.on('end', () => {
      response.statusCode = 201;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ length, header: request.headers['x-smoke'] }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const body = 'x'.repeat(40 * 1024);
    const response = await proxyFetch(`http://127.0.0.1:${address.port}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Smoke': 'yes' },
      body,
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { length: body.length, header: 'yes' });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
