import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCachedTTS, fetchCachedTTSTimings, ttsKey } from '../../services/api/tts.ts';

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

/** A fetch whose headers never arrive; only the request's timeout settles it. */
function stall(): void {
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
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
