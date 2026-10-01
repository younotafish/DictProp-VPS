import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { FetchLike } from '../src/ai-client.js';
import { createAiRoutes, type AiRouteDependencies } from '../src/routes/ai.js';

type Responder = (init: RequestInit) => Response | Promise<Response>;

const reply = (content: unknown, finishReason = 'stop') => () => new Response(JSON.stringify({
  choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finishReason }],
}));
const httpStatus = (code: number, body = '') => () => new Response(body, { status: code });
const hang: Responder = (init) => new Promise<Response>((_resolve, reject) => {
  const signal = init.signal!;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

// The AI routes on a bare app, with DeepInfra replaced by a script of responses (the last one repeats).
function harness(responders: Responder[], deps: Partial<AiRouteDependencies> = {}) {
  const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetch: FetchLike = async (url, init = {}) => {
    requests.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    return responders[Math.min(requests.length, responders.length) - 1](init);
  };
  const app = new Hono().route('/api', createAiRoutes({ fetch, apiKey: () => 'test-key', retryDelayMs: 0, ...deps }));
  const post = async (path: string, body: unknown, init: RequestInit = {}): Promise<Response> => app.request(new Request(`http://localhost/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  }));
  return {
    post,
    requests,
    system: (index: number): string => requests[index].body.messages[0].content,
    user: (index: number): string => requests[index].body.messages[1].content,
  };
}

async function keepingAlive<T>(run: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {}, 1_000);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

const card = (overrides: Record<string, unknown> = {}) => ({
  word: 'bank',
  sense: 'noun: finance',
  chinese: '银行',
  ipa: '/bæŋk/',
  definition: 'A business that keeps and lends money.',
  forms: ['bank', 'banks'],
  wordFamily: [{ word: 'banker', pos: 'noun', chinese: '银行家' }],
  synonyms: ['lender'],
  antonyms: [],
  confusables: ['bench'],
  examples: [
    'I stopped by the {{bank}} after work to deposit my paycheck.',
    'The {{bank}} approved our mortgage sooner than I expected.',
  ],
  history: 'From Italian banca, the bench where money changers worked.',
  register: 'Everyday',
  mnemonic: 'A bench (banca) where the money sat.',
  imagePrompt: 'A realistic neighborhood bank counter with a customer depositing a paycheck, natural daylight.',
  usageAudit: { status: 'current_general', reason: 'Normal in American English.', confidence: 'high' },
  ...overrides,
});
const riverCard = (overrides: Record<string, unknown> = {}) => card({
  sense: 'noun: river',
  chinese: '河岸',
  definition: 'The sloping land along the edge of a river.',
  examples: [
    'We sat on the {{bank}} and watched the river roll by all afternoon.',
    'The kids scrambled up the muddy {{bank}} after their canoe tipped.',
  ],
  mnemonic: 'Picture a river bank shaped like a long bench.',
  ...overrides,
});

// ── /analyze ────────────────────────────────────────────────────────────────

test('a failing card is re-asked alone with the validator reasons, and the fixed card is kept', async () => {
  const h = harness([
    reply({ query: 'bank', vocabs: [card(), riverCard({ mnemonic: '' })] }),
    reply({ vocabs: [riverCard()] }),
  ]);
  const response = await h.post('/analyze', { text: 'bank' });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.deepEqual(body.vocabs.map((vocab: any) => vocab.sense), ['noun: finance', 'noun: river']);
  assert.equal(h.requests.length, 2);
  assert.match(h.system(1), /Rewrite ONLY the cards you are given/);
  assert.match(h.user(1), /Headword: "bank"/);
  assert.match(h.user(1), /"mnemonic" must be a string of at least 10 characters/);
  // The card that passed is not re-generated.
  assert.doesNotMatch(h.user(1), /noun: finance/);
  assert.equal(h.requests[1].body.max_tokens, 12_000);
});

test('a card that never passes is dropped and its valid sibling is still returned', async () => {
  const h = harness([
    reply({ query: 'bank', vocabs: [card(), riverCard({ mnemonic: '' })] }),
    reply({ vocabs: [riverCard({ mnemonic: '' })] }),
  ]);
  const response = await h.post('/analyze', { text: 'bank' });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.deepEqual(body.vocabs.map((vocab: any) => vocab.sense), ['noun: finance']);
  assert.equal(h.requests.length, 3); // the answer plus two repair rounds
});

test('cards are returned with schema fields only, and a short register label is dropped without a retry', async () => {
  const h = harness([reply({ query: 'bank', vocabs: [card({ register: 'formal', advancedEnrichment: { v: 9 } })] })]);
  const response = await h.post('/analyze', { text: 'bank' });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.vocabs.length, 1);
  assert.equal(body.vocabs[0].register, '');
  assert.equal('advancedEnrichment' in body.vocabs[0], false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.max_tokens, 16_000);
});

test('gibberish ends at once as 422 with no retries', async () => {
  const h = harness([reply({ notFound: true, query: 'qwxzv' })]);
  const response = await h.post('/analyze', { text: 'qwxzv' });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'No dictionary entry found. Check the spelling and try again.', status: 422 });
  assert.equal(h.requests.length, 1);
});

test('an answer with no cards is re-asked once with feedback', async () => {
  const h = harness([reply({ query: 'bank', vocabs: [] }), reply({ query: 'bank', vocabs: [card()] })]);
  const response = await h.post('/analyze', { text: 'bank' });
  assert.equal(response.status, 200);
  assert.equal(h.requests.length, 2);
  assert.match(h.user(1), /contained no vocabulary cards/);
});

test('a sentence needs a translation or a card; one with neither fails after one re-ask', async () => {
  const translated = harness([reply({ query: 'The kids ran home', translation: '孩子们跑回家了。', grammar: 'Simple past.', vocabs: [] })]);
  const ok = await translated.post('/analyze', { text: 'The kids ran home' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as any).translation, '孩子们跑回家了。');
  assert.match(translated.system(0), /SENTENCE or longer text/);
  assert.equal(translated.requests.length, 1);

  const empty = harness([reply({ query: 'The kids ran home', translation: '', vocabs: [] })]);
  const failed = await empty.post('/analyze', { text: 'The kids ran home' });
  assert.equal(failed.status, 502);
  assert.equal(empty.requests.length, 2);
  assert.match(empty.user(1), /The Chinese translation is mandatory/);
});

test('a reply cut off twice is a 502, and the re-ask asks for a compact answer', async () => {
  const h = harness([reply('{"query":"bank","vocabs":[', 'length')]);
  const response = await h.post('/analyze', { text: 'bank' });
  assert.equal(response.status, 502);
  assert.equal((await response.json() as any).error, 'The AI response was cut off before it finished. Please try again.');
  assert.equal(h.requests.length, 2);
  assert.match(h.user(1), /too long and was cut off/);
});

test('provider failures map to 429 QUOTA_EXCEEDED, 429 RATE_LIMITED and 503', async () => {
  const quota = harness([httpStatus(402, 'Payment Required')]);
  const quotaResponse = await quota.post('/analyze', { text: 'bank' });
  assert.equal(quotaResponse.status, 429);
  assert.equal((await quotaResponse.json() as any).error, 'QUOTA_EXCEEDED');
  assert.equal(quota.requests.length, 1);

  const limited = harness([httpStatus(429, 'Too Many Requests')]);
  const limitedResponse = await limited.post('/analyze', { text: 'bank' });
  assert.equal(limitedResponse.status, 429);
  assert.equal((await limitedResponse.json() as any).error, 'RATE_LIMITED');
  assert.equal(limited.requests.length, 2);

  const down = harness([httpStatus(500, 'Internal Server Error')]);
  const downResponse = await down.post('/analyze', { text: 'bank' });
  assert.equal(downResponse.status, 503);
  assert.equal(down.requests.length, 2);
});

test('a client that disconnects stops the model call', async () => {
  const h = harness([hang]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const response = await h.post('/analyze', { text: 'bank' }, { signal: controller.signal });
  assert.equal(response.status, 499);
  assert.equal(h.requests.length, 1);
});

test('the overall budget turns a call that never answers into a 504', async () => {
  const h = harness([hang], { budgetsMs: { analyze: 50 } });
  const response = await keepingAlive(() => h.post('/analyze', { text: 'bank' }));
  assert.equal(response.status, 504);
  assert.equal(h.requests.length, 1);
});

test('user text is embedded as a JSON string, and batch items use the batch instructions', async () => {
  const h = harness([reply({ query: 'say "hi"', vocabs: [card({ word: 'say hi', examples: [
    'Just {{say hi}} to your manager when you pass her desk tomorrow.',
    'I only stopped by to {{say hi}} before the game started, honestly.',
  ] })] })]);
  const response = await h.post('/analyze', { text: 'say "hi"', mode: 'batch' });
  assert.equal(response.status, 200);
  assert.ok(h.user(0).endsWith(JSON.stringify('say "hi"')));
  assert.match(h.system(0), /already been identified as an uncommon\/advanced vocabulary item/);
});

test('bad analyze input is rejected before any model call', async () => {
  const h = harness([reply({})]);
  assert.equal((await h.post('/analyze', { text: '   ' })).status, 400);
  assert.equal((await h.post('/analyze', { text: 'x'.repeat(5001) })).status, 400);
  const noKey = harness([reply({})], { apiKey: () => undefined });
  assert.equal((await noKey.post('/analyze', { text: 'bank' })).status, 500);
  assert.equal(h.requests.length + noKey.requests.length, 0);
});

// ── /compare ────────────────────────────────────────────────────────────────

const WORDS = ['fleeting', 'transient', 'ephemeral', 'momentary', 'brief', 'passing', 'short-lived', 'evanescent', 'temporary'];
const comparison = (overrides: Record<string, unknown> = {}) => ({
  words: ['fleeting', 'transient'],
  summary: 'Both are 短暂的, but fleeting is more vivid.',
  dimensions: [{ label: 'Core Meaning', analysis: 'Both mean brief.', perWord: { fleeting: 'Very brief.', transient: 'Passing through.' } }],
  examples: [{ context: 'A glance', sentences: { fleeting: 'A fleeting glance.', transient: 'A transient visitor.' } }],
  commonMistakes: ['Using transient for a glance.'],
  verdict: 'Fleeting for moments, transient for states.',
  ...overrides,
});

test('comparisons accept up to 8 distinct words with an accurate message beyond that', async () => {
  const h = harness([reply(comparison({ words: WORDS.slice(0, 8) }))]);
  const tooMany = await h.post('/compare', { words: WORDS });
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json() as any).error, 'You can compare up to 8 words at a time.');
  const duplicates = await h.post('/compare', { words: ['Fleeting', ' fleeting '] });
  assert.equal(duplicates.status, 400);
  assert.equal((await duplicates.json() as any).error, 'Please provide at least 2 different words to compare.');
  assert.equal(h.requests.length, 0);

  const eight = await h.post('/compare', { words: WORDS.slice(0, 8) });
  assert.equal(eight.status, 200);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.max_tokens, 8_000);
  assert.ok(h.user(0).endsWith(JSON.stringify(WORDS.slice(0, 8))));
});

test('comparison output keeps only renderable strings and dimensions with content', async () => {
  const h = harness([reply(comparison({
    words: ['fleeting'],
    dimensions: [
      { label: 'Core Meaning', analysis: 'Both mean brief.', perWord: { fleeting: 'Very brief.', transient: 42, ephemeral: { nested: true } } },
      { label: '', analysis: 'No label.' },
      { label: 'Register', analysis: '', perWord: {} },
      null,
    ],
    examples: [
      { context: 'A glance', sentences: { fleeting: 'A fleeting glance.', transient: null } },
      { context: 'Nothing', sentences: {} },
    ],
    commonMistakes: ['Using transient for a glance.', 3, ''],
    verdict: 7,
  }))]);
  const response = await h.post('/compare', { words: ['fleeting', 'transient'] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    words: ['fleeting', 'transient'], // the model's list had the wrong length
    summary: 'Both are 短暂的, but fleeting is more vivid.',
    dimensions: [{ label: 'Core Meaning', analysis: 'Both mean brief.', perWord: { fleeting: 'Very brief.' } }],
    examples: [{ context: 'A glance', sentences: { fleeting: 'A fleeting glance.' } }],
    commonMistakes: ['Using transient for a glance.'],
    verdict: '',
  });
});

test('a comparison with no usable dimension is a 502', async () => {
  const h = harness([reply(comparison({ dimensions: [{ label: 'Empty', analysis: '', perWord: { fleeting: 5 } }] }))]);
  const response = await h.post('/compare', { words: ['fleeting', 'transient'] });
  assert.equal(response.status, 502);
  assert.equal(h.requests.length, 1);
});

// ── /extract-vocabulary ─────────────────────────────────────────────────────

test('extraction drops malformed entries, keeps each expression once and returns at most 12', async () => {
  const entry = (word: unknown) => ({ word, context: ' in context ', level: 'C1', reason: 'Worth it.' });
  const h = harness([reply({
    sourceLang: 'en',
    translation: '',
    words: [
      entry('Tenacity'), entry('tenacity '), entry('break  the ice'), entry('break the ice'), null, entry(42),
      { word: 'no context' },
      ...Array.from({ length: 14 }, (_unused, index) => entry(`word${index}`)),
    ],
  })]);
  const response = await h.post('/extract-vocabulary', { text: 'Some long text worth scanning.' });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.words.length, 12);
  assert.deepEqual(body.words.slice(0, 3).map((word: any) => word.word), ['Tenacity', 'break  the ice', 'word0']);
  assert.deepEqual(body.words[0], { word: 'Tenacity', context: 'in context', level: 'C1', reason: 'Worth it.' });
  assert.equal(body.sourceLang, 'en');
});

test('extraction reports nothing found as 404 and an all-malformed list as 502', async () => {
  const none = harness([reply({ words: [] })]);
  assert.equal((await none.post('/extract-vocabulary', { text: 'Hello there.' })).status, 404);
  const malformed = harness([reply({ words: [{ word: 1 }, null] })]);
  assert.equal((await malformed.post('/extract-vocabulary', { text: 'Hello there.' })).status, 502);
});

// ── /transcribe ─────────────────────────────────────────────────────────────

test('transcription uploads a bare-type file name and trims the text', async () => {
  const h = harness([() => new Response(JSON.stringify({ text: '  hello there  ' }))]);
  const audio = Buffer.from('fake-webm-bytes').toString('base64');
  const response = await h.post('/transcribe', { audio, mimeType: 'audio/webm;codecs=opus' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'hello there' });
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /whisper/);
  assert.deepEqual(h.requests[0].init.headers, { Authorization: 'Bearer test-key' });
  const form = h.requests[0].init.body;
  assert.ok(form instanceof FormData);
  const file = form.get('audio') as File;
  assert.equal(file.name, 'audio.webm');
  assert.equal(file.type, 'audio/webm');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'fake-webm-bytes');
});

test('transcription rejects bad input before the upload and maps provider quota', async () => {
  const h = harness([httpStatus(402, 'Payment Required')]);
  assert.equal((await h.post('/transcribe', { audio: 'not base64!!', mimeType: 'audio/webm' })).status, 400);
  assert.equal((await h.post('/transcribe', { audio: 'AAAA', mimeType: 'video/mp4' })).status, 415);
  assert.equal(h.requests.length, 0);
  const quota = await h.post('/transcribe', { audio: 'AAAA', mimeType: 'audio/ogg;codecs=opus' });
  assert.equal(quota.status, 429);
  assert.equal((await quota.json() as any).error, 'QUOTA_EXCEEDED');
  assert.equal(((h.requests[0].init.body as FormData).get('audio') as File).name, 'audio.ogg');
});
