import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJson, requestVoid } from '../../services/http.ts';

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

  globalThis.fetch = stallingFetch('headers');
  await assert.rejects(requestJson('/api/items', undefined, 'Load', 20), { name: 'TimeoutError' });
  await assert.rejects(requestVoid('/api/reviews', { method: 'POST' }, 'Save', 20), { name: 'TimeoutError' });

  // The deadline covers the body read too, so a response that stalls mid-body also settles.
  globalThis.fetch = stallingFetch('body');
  await assert.rejects(requestJson('/api/items', undefined, 'Load', 20), { name: 'TimeoutError' });
});

test('a caller abort still cancels a timed request', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = stallingFetch('headers');

  const controller = new AbortController();
  const pending = requestJson('/api/items', { signal: controller.signal }, 'Load', 60_000);
  controller.abort(new DOMException('User left', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError', message: 'User left' });
});
