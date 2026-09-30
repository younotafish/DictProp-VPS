import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import test from 'node:test';

// The proxy is chosen when the module loads, so clear it first to exercise the direct (VPS) path.
for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[name];
const { proxyFetch, curlFetch, describeProxy, NATIVE_BODY_TIMEOUT_MS, NATIVE_HEADERS_TIMEOUT_MS } = await import('../src/proxy-fetch.js');

async function withServer(
  handler: (request: IncomingMessage, body: Buffer, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => handler(request, Buffer.concat(chunks), response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('the direct path outlasts the longest AI window (a 600s comparison)', () => {
  assert.ok(NATIVE_HEADERS_TIMEOUT_MS > 600_000);
  assert.ok(NATIVE_BODY_TIMEOUT_MS > 600_000);
});

test('the direct path round-trips a JSON request', async () => {
  await withServer((request, body, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ method: request.method, auth: request.headers.authorization, body: JSON.parse(body.toString('utf8')) }));
  }, async (baseUrl) => {
    const response = await proxyFetch(`${baseUrl}/json`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { method: 'POST', auth: 'Bearer test', body: { hello: 'world' } });
  });
});

test('a global FormData is sent as multipart, not as the text "[object FormData]"', async () => {
  await withServer((request, body, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ contentType: request.headers['content-type'], auth: request.headers.authorization, body: body.toString('latin1') }));
  }, async (baseUrl) => {
    const form = new FormData();
    form.append('audio', new Blob([Buffer.from('RIFFfake-audio')], { type: 'audio/webm' }), 'audio.webm');
    const response = await proxyFetch(`${baseUrl}/upload`, { method: 'POST', headers: { Authorization: 'Bearer test' }, body: form });
    const echoed = await response.json() as { contentType: string; auth: string; body: string };
    assert.match(echoed.contentType, /^multipart\/form-data; boundary=/);
    assert.equal(echoed.auth, 'Bearer test');
    assert.match(echoed.body, /name="audio"; filename="audio\.webm"/);
    assert.match(echoed.body, /Content-Type: audio\/webm/);
    assert.match(echoed.body, /RIFFfake-audio/);
    assert.doesNotMatch(echoed.body, /\[object FormData\]/);
  });
});

test('a manual redirect still exposes its status and Location (image import depends on it)', async () => {
  await withServer((_request, _body, response) => {
    response.statusCode = 302;
    response.setHeader('Location', '/elsewhere');
    response.end();
  }, async (baseUrl) => {
    const response = await proxyFetch(`${baseUrl}/moved`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/elsewhere');
    await response.body?.cancel();
  });
});

test('an aborted signal rejects the request', async () => {
  await withServer(() => {
    // Never answer: the caller's signal must end the request.
  }, async (baseUrl) => {
    await assert.rejects(
      proxyFetch(`${baseUrl}/hang`, { signal: AbortSignal.timeout(100) }),
      (error: any) => error?.name === 'TimeoutError' || error?.name === 'AbortError',
    );
  });
});

test('the proxy log line leaves out credentials', () => {
  assert.equal(describeProxy('http://user:hunter2@proxy.example:8080'), 'http://proxy.example:8080 (credentials hidden)');
  assert.equal(describeProxy('http://localhost:10054'), 'http://localhost:10054');
  assert.equal(describeProxy('not a url'), '(unparseable proxy URL)');
});

test('the curl path keeps headers off its command line and removes their file afterwards', async () => {
  const curlDirs = () => readdirSync(tmpdir()).filter(name => name.startsWith('dictprop-curl-'));
  const before = new Set(curlDirs());
  // A fresh value, so no other command line (this test's own launcher, say) can contain it.
  const authorization = `Bearer ${randomUUID()}`;
  let visibleInProcessList = true;
  await withServer((request, body, response) => {
    // curl is still waiting for this answer, so its command line is in the process list now.
    visibleInProcessList = execFileSync('ps', ['-axo', 'args'], { encoding: 'utf8' }).includes(authorization);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ method: request.method, auth: request.headers.authorization, type: request.headers['content-type'], length: body.length }));
  }, async (baseUrl) => {
    const payload = JSON.stringify({ text: 'x'.repeat(40 * 1024) });
    const response = await curlFetch(`${baseUrl}/large`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { method: 'POST', auth: authorization, type: 'application/json', length: Buffer.byteLength(payload) });
  });
  assert.equal(visibleInProcessList, false);
  assert.deepEqual(curlDirs().filter(name => !before.has(name)), []);
});
