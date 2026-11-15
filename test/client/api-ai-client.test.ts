import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeInput, compareWords, loadComparisons } from '../../services/api.ts';
import { HttpError } from '../../services/http.ts';

// The AI client functions only need fetch from the browser; each test scripts its reply and records the calls.
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

function respondWith(respond: (body: any) => Response) {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    return respond(body);
  }) as typeof fetch;
  return calls;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('a comparison is checked before the request: the same word once, and at most 8 words', async () => {
  const calls = respondWith(() => json({}));
  await assert.rejects(compareWords(['affect', ' Affect ', 'AFFECT']), /at least 2 different words/);
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(letter => `word${letter}`);
  await assert.rejects(compareWords(nine), { message: 'You can compare up to 8 words at a time.' });
  assert.equal(calls.length, 0);
});

test('a malformed comparison keeps only its string parts', async () => {
  const calls = respondWith(() => json({
    words: [{ word: 'affect' }],
    summary: 'Both are 影响, but one is the verb.',
    dimensions: [
      { label: 'Core Meaning', analysis: 'x', perWord: { affect: 'to influence', effect: { meaning: 'a result' } } },
      { label: '', perWord: { affect: 'dropped: no label' } },
      'not a dimension',
    ],
    examples: [{ context: 'Weather', sentences: { affect: 'Rain affects my mood.', effect: 42 } }, { context: 'Empty', sentences: null }],
    commonMistakes: ['Using effect as a verb.', { wrong: true }],
    verdict: 7,
  }));
  const result = await compareWords(['affect', 'effect', 'affect']);
  assert.deepEqual(calls[0].body, { words: ['affect', 'effect'] });
  assert.deepEqual(result, {
    words: ['affect', 'effect'],
    summary: 'Both are 影响, but one is the verb.',
    dimensions: [{ label: 'Core Meaning', analysis: 'x', perWord: { affect: 'to influence' } }],
    examples: [{ context: 'Weather', sentences: { affect: 'Rain affects my mood.' } }],
    commonMistakes: ['Using effect as a verb.'],
    verdict: '',
  });
});

test('saved comparisons are cleaned for display, so an old malformed one cannot crash the view', async () => {
  respondWith(() => json([
    {
      key: 'affect|effect',
      words: ['affect', 'effect', 3],
      data: { words: ['affect', null], dimensions: [{ label: 'Register', perWord: { affect: ['neutral'] } }], examples: 'none' },
      updatedAt: 1,
    },
    null,
  ]));
  const [stored, ...rest] = await loadComparisons();
  assert.equal(rest.length, 0);
  assert.equal(stored.key, 'affect|effect');
  assert.equal(stored.updatedAt, 1);
  assert.deepEqual(stored.words, ['affect', 'effect']);
  assert.deepEqual(stored.data, {
    words: ['affect', 'effect'],
    summary: '',
    dimensions: [{ label: 'Register', analysis: '', perWord: {} }],
    examples: [],
    commonMistakes: [],
    verdict: '',
  });
});

test('analysis sends the batch mode and keeps statuses the search box maps to messages', async () => {
  const calls = respondWith(() => json({ query: 'had better', vocabs: [{ word: 'had better', sense: 'modal' }, { sense: 'no word' }] }));
  const result = await analyzeInput('had better', { mode: 'batch' });
  assert.deepEqual(calls[0].body, { text: 'had better', mode: 'batch' });
  assert.equal(calls[0].url, '/api/analyze');
  assert.deepEqual(result.vocabs.map(vocab => vocab.word), ['had better']);

  respondWith(() => json({ error: 'No dictionary entry found. Check the spelling and try again.' }, 422));
  await assert.rejects(analyzeInput('qwxzv'), (error: unknown) => error instanceof HttpError && error.status === 422);

  respondWith(() => json({ error: 'QUOTA_EXCEEDED' }, 429));
  await assert.rejects(analyzeInput('bank'), { message: 'QUOTA_EXCEEDED' });

  respondWith(() => json({ error: 'RATE_LIMITED' }, 429));
  await assert.rejects(analyzeInput('bank'), (error: unknown) =>
    error instanceof HttpError && error.status === 429 && /rate-limited/.test(error.message));
});
