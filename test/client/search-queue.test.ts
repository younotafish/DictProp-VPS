import assert from 'node:assert/strict';
import test from 'node:test';
import {
  busyCountOf, findLiveComparison, hasLiveDuplicate, queueUpdate, readyItemsOf, savedCardsResult, searchQueueReducer,
  type QueueAction, type QueueItem,
} from '../../components/search/searchQueue.ts';
import { comparisonKey, type ComparisonResult, type SearchResult, type VocabCard } from '../../types.ts';

const vocab = (word: string, sense = ''): VocabCard => ({
  id: `${word}-${sense}`, word, sense, chinese: '', ipa: `/${word}/`, definition: '', synonyms: [], antonyms: [],
  confusables: [], examples: [], history: '', register: '', mnemonic: '',
});

const result = (query: string): SearchResult => ({
  id: `r-${query}`, query, translation: '', grammar: '', visualKeyword: query, pronunciation: '', vocabs: [vocab(query)], timestamp: 1,
});

const comparison = (words: string[]): ComparisonResult => ({
  words, summary: 's', dimensions: [], examples: [], commonMistakes: [], verdict: 'v',
});

const run = (actions: QueueAction[], start: QueueItem[] = []): QueueItem[] => actions.reduce(searchQueueReducer, start);

const add = (id: string, query: string, extra: Partial<Extract<QueueAction, { type: 'add-search' }>> = {}): QueueAction =>
  ({ type: 'add-search', id, query, forceAI: false, ...extra });

test('a lookup joins the queue as pending, keeping its refresh flag and analysis mode', () => {
  assert.deepEqual(run([add('q-1', 'gamut', { analyzeMode: 'batch' })]), [
    { id: 'q-1', kind: 'search', query: 'gamut', status: 'pending', results: null, forceAI: false, analyzeMode: 'batch' },
  ]);
});

test('a lookup that repeats a running or ready one leaves the queue untouched, whatever its case', () => {
  for (const status of ['pending', 'searching', 'ready'] as const) {
    const queue: QueueItem[] = [{ id: 'q-1', kind: 'search', query: 'Gamut', status, results: null }];
    assert.equal(searchQueueReducer(queue, add('q-2', 'gamut')), queue, status);
    assert.equal(hasLiveDuplicate(queue, 'GAMUT'), true, status);
  }
});

test('a failed lookup can be asked for again', () => {
  const queue = run([add('q-1', 'gamut'), { type: 'fail', id: 'q-1' }]);
  assert.equal(hasLiveDuplicate(queue, 'gamut'), false);
  assert.deepEqual(run([add('q-2', 'gamut')], queue).map(item => [item.id, item.status]), [['q-1', 'failed'], ['q-2', 'pending']]);
});

test('a refresh replaces every entry for its query, whatever its status, and goes to the end', () => {
  const queue = run([
    add('q-1', 'gamut'), { type: 'search-ready', id: 'q-1', results: result('gamut') },
    add('q-2', 'impasse'),
    add('q-3', 'GAMUT', { forceAI: true }),
  ]);
  assert.deepEqual(queue.map(item => [item.id, item.query, item.status, item.forceAI]), [
    ['q-2', 'impasse', 'pending', false],
    ['q-3', 'GAMUT', 'pending', true],
  ]);
});

test('a comparison is pending, or ready at once when it was saved before', () => {
  const saved = comparison(['fable', 'parable']);
  assert.deepEqual(run([
    { type: 'add-compare', id: 'q-1', words: ['fable', 'parable'], cached: null },
    { type: 'add-compare', id: 'q-2', words: ['rot', 'decay', 'decompose'], cached: saved },
  ]), [
    { id: 'q-1', kind: 'compare', query: 'fable vs parable', words: ['fable', 'parable'], status: 'pending', results: null, comparison: null },
    { id: 'q-2', kind: 'compare', query: 'rot vs decay vs decompose', words: ['rot', 'decay', 'decompose'], status: 'ready', results: null, comparison: saved },
  ]);
});

test('a request settles only its own entry and leaves the others as they were', () => {
  const queue = run([add('q-1', 'gamut'), add('q-2', 'impasse'), { type: 'add-compare', id: 'q-3', words: ['a', 'b'], cached: null }]);
  const started = searchQueueReducer(queue, { type: 'start', id: 'q-2' });
  assert.equal(started[0], queue[0]);
  assert.equal(started[1].status, 'searching');
  const found = result('impasse');
  const ready = searchQueueReducer(started, { type: 'search-ready', id: 'q-2', results: found });
  assert.equal(ready[1].status, 'ready');
  assert.equal(ready[1].results, found);
  const compared = comparison(['a', 'b']);
  const settled = run([{ type: 'compare-ready', id: 'q-3', comparison: compared }, { type: 'fail', id: 'q-1' }], ready);
  assert.deepEqual(settled.map(item => item.status), ['failed', 'ready', 'ready']);
  assert.equal(settled[2].comparison, compared);
});

test('an in-place refresh keeps the old result showing until the fresh one replaces it', () => {
  const queue = run([
    add('q-1', 'run', { analyzeMode: 'batch' }), { type: 'search-ready', id: 'q-1', results: result('run') },
    { type: 'refresh-start', id: 'q-1' },
  ]);
  assert.equal(queue[0].refreshing, true);
  assert.equal(queue[0].results?.query, 'run');
  assert.equal(readyItemsOf(queue).length, 1);

  const fresh = result('run out');
  const refreshed = searchQueueReducer(queue, { type: 'refresh-ready', id: 'q-1', query: 'run out', results: fresh });
  assert.deepEqual(
    { ...refreshed[0], results: refreshed[0].results?.query },
    { id: 'q-1', kind: 'search', query: 'run out', status: 'ready', results: 'run out', forceAI: false, analyzeMode: 'batch', refreshing: false },
  );

  const failed = searchQueueReducer(queue, { type: 'refresh-fail', id: 'q-1' });
  assert.equal(failed[0].refreshing, false);
  assert.equal(failed[0].status, 'ready');
  assert.equal(failed[0].results?.query, 'run');
});

test('dismiss drops one entry, and clear all keeps only the entries still running', () => {
  const queue = run([
    add('q-1', 'a'), { type: 'search-ready', id: 'q-1', results: result('a') },
    add('q-2', 'b'), { type: 'start', id: 'q-2' },
    add('q-3', 'c'), { type: 'fail', id: 'q-3' },
    add('q-4', 'd'),
  ]);
  assert.deepEqual(searchQueueReducer(queue, { type: 'dismiss', id: 'q-1' }).map(item => item.id), ['q-2', 'q-3', 'q-4']);
  assert.deepEqual(searchQueueReducer(queue, { type: 'clear-finished' }).map(item => item.id), ['q-2', 'q-4']);
});

test('queueUpdate applies an action to the queue it is given', () => {
  const queue = run([add('q-1', 'a')]);
  assert.deepEqual(queueUpdate({ type: 'start', id: 'q-1' })(queue), searchQueueReducer(queue, { type: 'start', id: 'q-1' }));
});

test('ready results keep the order they were asked for, not the order they finished in', () => {
  const queue = run([
    add('q-1', 'obfuscate'), add('q-2', 'run'),
    { type: 'search-ready', id: 'q-2', results: result('run') },
    { type: 'search-ready', id: 'q-1', results: result('obfuscate') },
  ]);
  assert.deepEqual(readyItemsOf(queue).map(item => item.id), ['q-1', 'q-2']);
});

test('the busy count covers queued and running lookups and comparisons', () => {
  const queue = run([
    add('q-1', 'a'), add('q-2', 'b'), { type: 'start', id: 'q-2' },
    { type: 'add-compare', id: 'q-3', words: ['x', 'y'], cached: null },
    add('q-4', 'c'), { type: 'search-ready', id: 'q-4', results: result('c') },
    add('q-5', 'd'), { type: 'fail', id: 'q-5' },
  ]);
  assert.equal(busyCountOf(queue), 3);
});

test('a comparison is found by its word set in any order, unless it failed', () => {
  const queue = run([
    { type: 'add-compare', id: 'q-1', words: ['Fable', 'parable'], cached: null },
    { type: 'add-compare', id: 'q-2', words: ['rot', 'decay'], cached: null }, { type: 'fail', id: 'q-2' },
    add('q-3', 'fable vs parable'),
  ]);
  assert.equal(findLiveComparison(queue, comparisonKey(['parable', 'fable']))?.id, 'q-1');
  assert.equal(findLiveComparison(queue, comparisonKey(['decay', 'rot'])), undefined);
});

test('a saved word shows its saved cards as the result, without a translation', () => {
  const cards = [vocab('run', 'verb'), vocab('run', 'noun')];
  assert.deepEqual(savedCardsResult('q-7', 'running', cards, 42), {
    id: 'saved-q-7', query: 'running', translation: '', grammar: '', visualKeyword: 'run', pronunciation: '/run/', vocabs: cards, timestamp: 42,
  });
});
