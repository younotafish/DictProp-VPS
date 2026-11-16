import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithin, requestJson, requestVoid, TimeoutError } from '../../services/http.ts';

// A fetch whose headers or body never arrive, as on a wedged mobile socket; only an abort settles it.
function stallingFetch(stage: 'headers' | 'body'): typeof fetch {
  return ((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (stage === 'body') {
      resolve({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, rejectBody) => {
          signal?.addEventListener('abort', () => rejectBody(signal.reason), { once: true });
        }),
      } as Response);
    }
  })) as typeof fetch;
}

test('a stalled request times out instead of holding sync guards forever', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Every timed request rejects with the one TimeoutError class, so callers can tell a timeout from any other failure.
  const timedOut = (error: unknown) => error instanceof TimeoutError && error.name === 'TimeoutError' && error.message === 'Request timed out';
  globalThis.fetch = stallingFetch('headers');
  await assert.rejects(requestJson('/api/items', undefined, 'Load', 20), timedOut);
  await assert.rejects(requestVoid('/api/reviews/apply', { method: 'POST' }, 'Save', 20), timedOut);
  await assert.rejects(fetchWithin('/api/tts/abc.mp3', undefined, 20, async (response) => response.blob()), timedOut);

  // The deadline covers the body read too, so a response that stalls mid-body also settles.
  globalThis.fetch = stallingFetch('body');
  await assert.rejects(requestJson('/api/items', undefined, 'Load', 20), timedOut);
});

test('a caller abort still cancels a timed request', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = stallingFetch('headers');

  const controller = new AbortController();
  const pending = requestJson('/api/items', { signal: controller.signal }, 'Load', 60_000);
  const reason = new DOMException('User left', 'AbortError');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason, 'the caller\'s own reason, never a TimeoutError');
});
