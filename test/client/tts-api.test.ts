import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERATE_MAX_ITEMS } from '../../server/src/shared/ai-limits.ts';
import {
  fetchCachedClip, fetchCachedClipByKey, fetchCachedTimings, fetchCachedTimingsByKey, fetchCachedTTS, fetchCachedTTSTimings,
  requestTTSGeneration, ttsKey,
} from '../../services/api/tts.ts';

// The cached-clip requests only need fetch; each test scripts the server's answer.
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

function serve(respond: (url: string) => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return respond(url);
  }) as typeof fetch;
  return urls;
}

/** A fetch whose headers never arrive; only an abort (the request's timeout or the caller's) settles it. */
function stall(): void {
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) return reject(init.signal.reason);
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

test('a cached clip and its timings come back by key, and a miss, an error or a stall gives null', async () => {
  const urls = serve(url => url.endsWith('.mp3')
    ? new Response(new Blob(['mp3 bytes'], { type: 'audio/mpeg' }))
    : Response.json([{ start: 0, end: 0.4, text: 'Hi' }]));
  assert.equal(await (await fetchCachedTTS('abc'))!.text(), 'mp3 bytes');
  assert.deepEqual(await fetchCachedTTSTimings('abc'), [{ start: 0, end: 0.4, text: 'Hi' }]);
  assert.deepEqual(urls, ['/api/tts/abc.mp3', '/api/tts/abc/timings']);

  serve(() => new Response('', { status: 404 }));
  assert.equal(await fetchCachedTTS('abc'), null);
  assert.equal(await fetchCachedTTSTimings('abc'), null);
  serve(() => Response.json({ not: 'timings' }));
  assert.equal(await fetchCachedTTSTimings('abc'), null);
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  assert.equal(await fetchCachedTTS('abc'), null);

  stall();
  assert.equal(await fetchCachedTTS('abc', 20), null);
  assert.equal(await fetchCachedTTSTimings('abc', 20), null);
});

test('a clip key is the SHA-256 of the voice, a newline and the trimmed text, as the server derives it', async () => {
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update('Mia\nA sentence to read.').digest('hex');
  assert.equal(await ttsKey('  A sentence to read.\n', 'Mia'), expected);
  // The digests server/test/tts-cache.test.ts pins for the server's ttsKey: a change on either side fails one test.
  assert.equal(await ttsKey('Hello there.', 'Mia'), '34a7fda7ef25705c6b91e942cfa7f3ee00e54fc69077e90d38e3fc19feb04474');
  assert.equal(await ttsKey('Hello there.', 'casual'), 'd32c1ac7577ce5d329f49b606bcc9e6ccb7b4fe22541ae2fbcc95d4f4e0a12b1');
});

test('a generation request goes out in chunks of the most clips the server takes at once, and the counts add up', async () => {
  const chunks: Array<Array<{ text: string; voice?: string }>> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    assert.equal(url, '/api/tts/generate');
    assert.equal(init?.method, 'POST');
    const { items } = JSON.parse(String(init?.body)) as { items: Array<{ text: string; voice?: string }> };
    chunks.push(items);
    return Response.json({ generated: items.length - 1, skipped: 1, failed: 0 });
  }) as typeof fetch;

  const items = Array.from({ length: GENERATE_MAX_ITEMS * 2 + 1 }, (_, index) => ({ text: `Sentence ${index}.`, voice: 'Mia' }));
  assert.deepEqual(await requestTTSGeneration(items), { generated: items.length - 3, skipped: 3, failed: 0 });
  assert.deepEqual(chunks.map(chunk => chunk.length), [GENERATE_MAX_ITEMS, GENERATE_MAX_ITEMS, 1]);
  assert.deepEqual(chunks.flat(), items, 'every clip once, in order');
});

test('a cache lookup tells a hit from a missing clip, which only a 404 means, and from a failure', async () => {
  serve(url => url.endsWith('.mp3')
    ? new Response(new Blob(['mp3 bytes'], { type: 'audio/mpeg' }))
    : Response.json([{ start: 0, end: 0.4, text: 'Hi' }]));
  const clip = await fetchCachedClipByKey('abc');
  assert.equal(clip.kind, 'hit');
  assert.equal(clip.kind === 'hit' && await clip.value.text(), 'mp3 bytes');
  assert.deepEqual(await fetchCachedTimingsByKey('abc'), { kind: 'hit', value: [{ start: 0, end: 0.4, text: 'Hi' }] });

  serve(() => new Response('', { status: 404 }));
  assert.deepEqual(await fetchCachedClipByKey('abc'), { kind: 'missing' });
  assert.deepEqual(await fetchCachedTimingsByKey('abc'), { kind: 'missing' });

  // Anything else may answer differently next time, so it is a failure, never a reason to generate the clip.
  for (const status of [500, 503, 401]) {
    serve(() => new Response('', { status }));
    assert.deepEqual(await fetchCachedClipByKey('abc'), { kind: 'failed' }, `status ${status}`);
    assert.deepEqual(await fetchCachedTimingsByKey('abc'), { kind: 'failed' }, `status ${status}`);
  }
  serve(() => Response.json({ not: 'timings' }));
  assert.deepEqual(await fetchCachedTimingsByKey('abc'), { kind: 'failed' });
  serve(() => new Response('not json'));
  assert.deepEqual(await fetchCachedTimingsByKey('abc'), { kind: 'failed' });
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  assert.deepEqual(await fetchCachedClipByKey('abc'), { kind: 'failed' });
  assert.deepEqual(await fetchCachedTimingsByKey('abc'), { kind: 'failed' });

  stall();
  assert.deepEqual(await fetchCachedClipByKey('abc', { timeoutMs: 20 }), { kind: 'failed' });
  assert.deepEqual(await fetchCachedTimingsByKey('abc', { timeoutMs: 20 }), { kind: 'failed' });
});

test('aborting a cache lookup ends its request at once, as a failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stall();
  const controller = new AbortController();
  const clip = fetchCachedClipByKey('abc', { signal: controller.signal });
  const timings = fetchCachedTimingsByKey('abc', { signal: controller.signal });
  assert.equal(await pending(clip), true);
  controller.abort();
  assert.equal(await pending(clip), false, 'the abort reached the request, with no timeout to wait for');
  assert.deepEqual(await clip, { kind: 'failed' });
  assert.deepEqual(await timings, { kind: 'failed' });

  assert.deepEqual(await fetchCachedClipByKey('abc', { signal: controller.signal }), { kind: 'failed' }, 'already aborted');
});

test('a lookup by text and voice asks for the clip at their key', async () => {
  // ttsKey('Hello there.', 'Mia'), as pinned above.
  const key = '34a7fda7ef25705c6b91e942cfa7f3ee00e54fc69077e90d38e3fc19feb04474';
  const urls = serve(url => url.endsWith('.mp3') ? new Response('mp3 bytes') : Response.json([]));
  const clip = await fetchCachedClip('  Hello there.\n', 'Mia');
  assert.equal(clip.kind === 'hit' && await clip.value.text(), 'mp3 bytes');
  assert.deepEqual(await fetchCachedTimings('Hello there.', 'Mia'), { kind: 'hit', value: [] });
  assert.deepEqual(urls, [`/api/tts/${key}.mp3`, `/api/tts/${key}/timings`]);

  serve(() => new Response('', { status: 404 }));
  assert.deepEqual(await fetchCachedClip('Hello there.', 'casual'), { kind: 'missing' });
  const controller = new AbortController();
  controller.abort();
  stall();
  assert.deepEqual(await fetchCachedTimings('Hello there.', 'Mia', { signal: controller.signal }), { kind: 'failed' });
});
