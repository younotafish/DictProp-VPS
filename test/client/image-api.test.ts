import assert from 'node:assert/strict';
import test from 'node:test';
import { loadItemImage, loadItemImagesBatch, uploadImages } from '../../services/api/images.ts';
import { importJSON } from '../../services/api/jsonImport.ts';

// These requests only need fetch; each test scripts the server's answer.
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

function serve(respond: (url: string, init: RequestInit) => Response | Promise<Response>): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return calls;
}

/** A server whose reply never arrives, as on a wedged mobile socket: only the request's timeout settles it. */
function stall(): void {
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
}

/** Whether `promise` is still pending after the microtasks queued so far run. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  return !settled;
}

test('a picture download: the file, null for a picture the server lacks, and a throw for anything else', async () => {
  const calls = serve(() => new Response(new Blob(['webp'], { type: 'image/webp' })));
  assert.equal(await (await loadItemImage('item 1', 'v1'))!.text(), 'webp');
  assert.equal(calls[0].url, '/api/items/item%201/image?v=v1');
  serve(() => new Response('', { status: 404 }));
  assert.equal(await loadItemImage('item'), null);
  serve(() => new Response('', { status: 503 }));
  await assert.rejects(loadItemImage('item'), /Failed to load image: 503/);
});

test('a stalled picture download fails after a minute, so the card retries instead of spinning for minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stall();
  const download = loadItemImage('item');
  t.mock.timers.tick(59_999);
  assert.equal(await pending(download), true);
  t.mock.timers.tick(1);
  await assert.rejects(download, { name: 'TimeoutError' });

  // The batch download counts such a picture as missing and goes on with the rest.
  stall();
  const batch = loadItemImagesBatch(['a']);
  t.mock.timers.tick(60_000);
  assert.equal((await batch).size, 0);
});

test('uploads send each picture as its own file, in order, and a stalled one fails after two minutes', async (t) => {
  const calls = serve(() => Response.json({ ok: true }));
  await uploadImages({ a: 'data:image/png;base64,iVBORw0KGgo=', b: new Blob(['b'], { type: 'image/webp' }) });
  assert.deepEqual(calls.map(call => [call.url, call.init.method, (call.init.headers as Record<string, string>)['Content-Type']]), [
    ['/api/items/a/image', 'PUT', 'image/png'],
    ['/api/items/b/image', 'PUT', 'image/webp'],
  ]);
  serve(() => new Response('', { status: 413 }));
  await assert.rejects(uploadImages({ a: new Blob(['a'], { type: 'image/png' }) }), /Upload image failed \(413\)/);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  stall();
  const upload = uploadImages({ a: new Blob(['a'], { type: 'image/png' }) });
  t.mock.timers.tick(119_999);
  assert.equal(await pending(upload), true);
  t.mock.timers.tick(1);
  await assert.rejects(upload, { name: 'TimeoutError' });
});

test('an import passes the server\'s reply through as the error message, and a stall past ten minutes says so', async (t) => {
  serve(() => Response.json({ ok: true, imported: 2, skipped: 0, imagesFetched: 1 }));
  assert.deepEqual(await importJSON([{}]), { ok: true, imported: 2, skipped: 0, imagesFetched: 1 });
  // The import dialog reads the raw body out of the message: a JSON error, text, or the status when it is empty.
  serve(() => Response.json({ error: 'Expected an array' }, { status: 400 }));
  await assert.rejects(importJSON([]), { message: '{"error":"Expected an array"}' });
  serve(() => new Response('', { status: 502 }));
  await assert.rejects(importJSON([]), { message: 'Import failed: 502' });
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  await assert.rejects(importJSON([]), TypeError, 'no connection stays a TypeError, which the dialog words itself');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  stall();
  const importing = importJSON([]);
  t.mock.timers.tick(10 * 60_000);
  await assert.rejects(importing, {
    message: 'The server took too long to answer. The import may still finish, so check your notebook before importing again.',
  });
});
