import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiError,
  aiErrorBody,
  aiErrorStatus,
  classifyAiError,
  createChatClient,
  createRequestContext,
  providerError,
  type ChatRequest,
  type FetchLike,
} from '../src/ai-client.js';

type Responder = (init: RequestInit) => Response | Promise<Response>;

// A fetch stub that answers from a script (the last responder repeats) and records each request body.
function stubFetch(...responders: Responder[]) {
  const bodies: any[] = [];
  const fetch: FetchLike = async (_url, init = {}) => {
    bodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : init.body);
    return responders[Math.min(bodies.length, responders.length) - 1](init);
  };
  return { fetch, bodies };
}

const reply = (content: unknown, finishReason = 'stop') => () => new Response(JSON.stringify({
  choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finishReason }],
}));
const status = (code: number, body = '') => () => new Response(body, { status: code });
// Never answers; rejects with the signal's reason, like fetch does.
const hang: Responder = (init) => new Promise<Response>((_resolve, reject) => {
  const signal = init.signal!;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

const REQUEST: ChatRequest = { system: 'system prompt', user: 'user prompt', maxTokens: 1234, label: 'test' };
const client = (fetch: FetchLike, apiKey: () => string | undefined = () => 'test-key') =>
  createChatClient({ fetch, apiKey, retryDelayMs: 0 });
const kindOf = (kind: AiError['kind']) => (error: unknown) => error instanceof AiError && error.kind === kind;

// AbortSignal.timeout timers do not keep the process alive; hold it open while a test waits on one.
async function keepingAlive<T>(run: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {}, 1_000);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

test('transport failures map to accurate kinds and statuses', () => {
  const undiciTimeout = (code: string) => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Timeout Error'), { code }),
  });
  const cases: Array<[unknown, AiError['kind'], number]> = [
    [undiciTimeout('UND_ERR_HEADERS_TIMEOUT'), 'timeout', 504],
    [undiciTimeout('UND_ERR_BODY_TIMEOUT'), 'timeout', 504],
    [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'timeout', 504],
    [new Error('curl exited 28: Operation timed out'), 'timeout', 504],
    [Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }), 'unavailable', 503],
    [new Error('curl exited 7: Failed to connect'), 'unavailable', 503],
    [new Error('boom'), 'internal', 500],
  ];
  for (const [error, kind, httpStatus] of cases) {
    const classified = classifyAiError(error);
    assert.equal(classified.kind, kind, String(error));
    assert.equal(aiErrorStatus(classified), httpStatus);
  }
  // A disconnected client wins over whatever the abort looked like.
  const disconnected = AbortSignal.abort();
  const cancelled = classifyAiError(new DOMException('aborted', 'AbortError'), disconnected);
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(aiErrorStatus(cancelled), 499);
});

test('provider statuses: 402 and billing 429s are quota, other 429s a rate limit, 5xx unavailable', () => {
  assert.equal(providerError(402, 'Payment Required').kind, 'quota');
  assert.equal(providerError(429, 'Too Many Requests').kind, 'rate_limited');
  assert.equal(providerError(429, '{"error":"insufficient balance"}').kind, 'quota');
  assert.equal(providerError(503, 'Service Unavailable').kind, 'unavailable');
  assert.equal(providerError(400, 'bad request').kind, 'config');
  const messages = { label: 'Test', failed: 'Test failed.' };
  assert.deepEqual(aiErrorBody(providerError(402, ''), messages), { error: 'QUOTA_EXCEEDED', status: 429 });
  assert.deepEqual(aiErrorBody(providerError(429, ''), messages), { error: 'RATE_LIMITED', status: 429 });
  assert.equal(aiErrorBody(providerError(500, ''), messages).status, 503);
  assert.equal(aiErrorBody(new AiError('invalid', 'x'), messages).status, 502);
  assert.equal(aiErrorBody(new AiError('truncated', 'x'), messages).status, 502);
  assert.equal(aiErrorBody(new AiError('not_found', 'x'), messages).status, 422);
});

test('a reply is parsed, and the request bounds output with max_tokens', async () => {
  const { fetch, bodies } = stubFetch(reply({ query: 'bank' }));
  assert.deepEqual(await client(fetch)(createRequestContext(undefined, 60_000), REQUEST), { query: 'bank' });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].max_tokens, 1234);
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.deepEqual(bodies[0].messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'user prompt' },
  ]);
});

test('a reply cut off at max_tokens is its own error and is not retried', async () => {
  const { fetch, bodies } = stubFetch(reply('{"query":"ba', 'length'));
  await assert.rejects(client(fetch)(createRequestContext(undefined, 60_000), REQUEST), kindOf('truncated'));
  assert.equal(bodies.length, 1);
});

test('a provider 5xx is retried once', async () => {
  const recovered = stubFetch(status(500), reply({ ok: true }));
  assert.deepEqual(await client(recovered.fetch)(createRequestContext(undefined, 60_000), REQUEST), { ok: true });
  assert.equal(recovered.bodies.length, 2);

  const down = stubFetch(status(503));
  await assert.rejects(client(down.fetch)(createRequestContext(undefined, 60_000), REQUEST), kindOf('unavailable'));
  assert.equal(down.bodies.length, 2);
});

test('quota, timeouts and missing keys are not retried', async () => {
  const quota = stubFetch(status(402, 'Payment Required'));
  await assert.rejects(client(quota.fetch)(createRequestContext(undefined, 60_000), REQUEST), kindOf('quota'));
  assert.equal(quota.bodies.length, 1);

  const timedOut = stubFetch(() => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(client(timedOut.fetch)(createRequestContext(undefined, 60_000), REQUEST), kindOf('timeout'));
  assert.equal(timedOut.bodies.length, 1);

  const noKey = stubFetch(reply({}));
  await assert.rejects(client(noKey.fetch, () => undefined)(createRequestContext(undefined, 60_000), REQUEST), kindOf('config'));
  assert.equal(noKey.bodies.length, 0);
});

test('unparseable content is retried once, then reported as invalid', async () => {
  const { fetch, bodies } = stubFetch(reply('this is not JSON'));
  await assert.rejects(client(fetch)(createRequestContext(undefined, 60_000), REQUEST), kindOf('invalid'));
  assert.equal(bodies.length, 2);
});

test('no retry starts when the budget cannot fit a useful window', async () => {
  const { fetch, bodies } = stubFetch(status(500));
  await assert.rejects(client(fetch)(createRequestContext(undefined, 10_000), REQUEST), kindOf('unavailable'));
  assert.equal(bodies.length, 1);
});

test('a provider that rejects max_tokens is asked again without it', async () => {
  const { fetch, bodies } = stubFetch(
    status(400, '{"error":{"message":"max_tokens must be less than or equal to 8192"}}'),
    reply({ ok: true }),
  );
  assert.deepEqual(await client(fetch)(createRequestContext(undefined, 60_000), REQUEST), { ok: true });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 1234);
  assert.equal('max_tokens' in bodies[1], false);
});

test('a client that disconnects cancels the call instead of retrying', async () => {
  const before = stubFetch(reply({}));
  await assert.rejects(client(before.fetch)(createRequestContext(AbortSignal.abort(), 60_000), REQUEST), kindOf('cancelled'));
  assert.equal(before.bodies.length, 0);

  const controller = new AbortController();
  const during = stubFetch(hang);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(client(during.fetch)(createRequestContext(controller.signal, 60_000), REQUEST), kindOf('cancelled'));
  assert.equal(during.bodies.length, 1);
});

test('the overall budget ends a call that never answers', async () => {
  const { fetch, bodies } = stubFetch(hang);
  await keepingAlive(() => assert.rejects(client(fetch)(createRequestContext(undefined, 30), REQUEST), kindOf('timeout')));
  assert.equal(bodies.length, 1);
});
