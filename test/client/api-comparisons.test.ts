import assert from 'node:assert/strict';
import test from 'node:test';
import { loadComparisons, sanitizeStoredComparisons } from '../../services/api/comparisons.ts';
import type { StoredComparison } from '../../types.ts';

const wellFormed: StoredComparison = {
  key: 'fable|parable',
  words: ['fable', 'parable'],
  data: {
    words: ['fable', 'parable'],
    summary: 'A fable has animals; a parable has people.',
    dimensions: [{ label: 'Characters', analysis: 'Who acts.', perWord: { fable: 'animals', parable: 'people' } }],
    examples: [{ context: 'Teaching', sentences: { fable: 'The fox and the grapes.', parable: 'The good Samaritan.' } }],
    commonMistakes: ['Calling every moral story a fable.'],
    verdict: 'Animals: fable. People: parable.',
  },
  updatedAt: 1_700_000_000_000,
};

test('a list that is not a list reads as no comparisons', () => {
  for (const raw of [null, undefined, {}, '[]', 42, { 0: wellFormed, length: 1 }]) {
    assert.deepEqual(sanitizeStoredComparisons(raw), [], JSON.stringify(raw) ?? 'undefined');
  }
});

test('a well-formed list reads back unchanged', () => {
  assert.deepEqual(sanitizeStoredComparisons([wellFormed]), [wellFormed]);
});

test('an entry that is not an object is dropped', () => {
  assert.deepEqual(sanitizeStoredComparisons([null, 'fable|parable', 7, true, undefined, wellFormed]), [wellFormed]);
});

test('only string words are kept, and a result whose own words are malformed falls back to them', () => {
  const [entry] = sanitizeStoredComparisons([{ ...wellFormed, words: ['fable', 3, null, 'parable'], data: { ...wellFormed.data, words: ['fable', null] } }]);
  assert.deepEqual(entry.words, ['fable', 'parable']);
  assert.deepEqual(entry.data.words, ['fable', 'parable']);

  const [noWords] = sanitizeStoredComparisons([{ ...wellFormed, words: 'fable parable' }]);
  assert.deepEqual(noWords.words, []);
  assert.deepEqual(noWords.data.words, ['fable', 'parable'], "the result's own words still stand");
});

test('a malformed result keeps only its string parts', () => {
  const [entry] = sanitizeStoredComparisons([{
    ...wellFormed,
    data: {
      words: ['fable', 'parable'],
      summary: { text: 'not a string' },
      dimensions: [
        { label: 'Characters', analysis: 3, perWord: { fable: 'animals', parable: ['people'] } },
        { label: '', perWord: { fable: 'dropped: no label' } },
        'not a dimension',
      ],
      examples: [{ context: 'Teaching', sentences: { fable: 'The fox.', parable: 42 } }, { context: 'Empty', sentences: null }],
      commonMistakes: ['Calling every moral story a fable.', { wrong: true }, '  '],
      verdict: 7,
    },
  }]);
  assert.deepEqual(entry.data, {
    words: ['fable', 'parable'],
    summary: '',
    dimensions: [{ label: 'Characters', analysis: '', perWord: { fable: 'animals' } }],
    examples: [{ context: 'Teaching', sentences: { fable: 'The fox.' } }],
    commonMistakes: ['Calling every moral story a fable.'],
    verdict: '',
  });

  const [missing] = sanitizeStoredComparisons([{ key: 'a|b', words: ['a', 'b'], updatedAt: 1 }]);
  assert.deepEqual(missing.data, { words: ['a', 'b'], summary: '', dimensions: [], examples: [], commonMistakes: [], verdict: '' });
});

test('the key, the time and any other field are kept as saved', () => {
  const [entry] = sanitizeStoredComparisons([{ key: 42, words: ['a', 'b'], data: wellFormed.data, updatedAt: 'yesterday', note: 'kept' }]);
  assert.equal((entry as unknown as { key: unknown }).key, 42);
  assert.equal((entry as unknown as { updatedAt: unknown }).updatedAt, 'yesterday');
  assert.equal((entry as unknown as { note: unknown }).note, 'kept');
});

test('the server list loads cleaned the same way', async t => {
  const reply = [
    { key: 'affect|effect', words: ['affect', 'effect', 3], data: { words: ['affect', null], examples: 'none' }, updatedAt: 1 },
    null,
    wellFormed,
  ];
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  assert.deepEqual(await loadComparisons(), sanitizeStoredComparisons(reply));
  assert.deepEqual(calls, ['/api/comparisons']);
});
