import assert from 'node:assert/strict';
import test from 'node:test';
import {
  busyCountOf, classifyEnqueue, createRefreshLog, findLiveComparison, findLiveLookup, hasLiveDuplicate, isQueued,
  openIndexForResults, queueUpdate, readyItemsOf, savedCardsResult, searchQueueReducer, unseenReadyCount,
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
const start = (id: string, at = 1_000): QueueAction => ({ type: 'start', id, at });

test('a lookup joins the queue as pending and unseen, keeping its refresh flag and analysis mode', () => {
  assert.deepEqual(run([add('q-1', 'gamut', { analyzeMode: 'batch' })]), [
    { id: 'q-1', kind: 'lookup', query: 'gamut', status: 'pending', results: null, seen: false, forceAI: false, analyzeMode: 'batch' },
  ]);
});

test('a lookup that repeats a running or ready one leaves the queue untouched, whatever its case', () => {
  for (const status of ['pending', 'searching', 'ready'] as const) {
    const queue: QueueItem[] = [{ id: 'q-1', kind: 'lookup', query: 'Gamut', status, results: null, seen: false }];
    assert.equal(searchQueueReducer(queue, add('q-2', 'gamut')), queue, status);
    assert.equal(hasLiveDuplicate(queue, 'GAMUT'), true, status);
  }
});

test('a failed lookup asked for again gives way to the new one', () => {
  const queue = run([add('q-1', 'gamut'), add('q-2', 'impasse'), { type: 'fail', id: 'q-1' }]);
  assert.equal(hasLiveDuplicate(queue, 'gamut'), false);
  assert.deepEqual(run([add('q-3', 'Gamut')], queue).map(item => [item.id, item.status]), [['q-2', 'pending'], ['q-3', 'pending']]);
});

test("a failed comparison stays when a lookup of its text is asked for, since it isn't that lookup", () => {
  const queue = run([{ type: 'add-compare', id: 'q-1', words: ['fable', 'parable'], cached: null }, { type: 'fail', id: 'q-1' }]);
  assert.deepEqual(run([add('q-2', 'fable vs parable')], queue).map(item => [item.id, item.status]), [['q-1', 'failed'], ['q-2', 'pending']]);
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
    { id: 'q-1', kind: 'compare', query: 'fable vs parable', words: ['fable', 'parable'], status: 'pending', results: null, comparison: null, seen: false },
    { id: 'q-2', kind: 'compare', query: 'rot vs decay vs decompose', words: ['rot', 'decay', 'decompose'], status: 'ready', results: null, comparison: saved, seen: false },
  ]);
});

test('a request settles only its own entry and leaves the others as they were', () => {
  const queue = run([add('q-1', 'gamut'), add('q-2', 'impasse'), { type: 'add-compare', id: 'q-3', words: ['a', 'b'], cached: null }]);
  const started = searchQueueReducer(queue, start('q-2', 5_000));
  assert.equal(started[0], queue[0]);
  assert.equal(started[1].status, 'searching');
  assert.equal(started[1].startedAt, 5_000, 'when the request went out');
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
    { id: 'q-1', kind: 'lookup', query: 'run out', status: 'ready', results: 'run out', seen: false, forceAI: false, analyzeMode: 'batch', refreshing: false },
  );

  const failed = searchQueueReducer(queue, { type: 'refresh-fail', id: 'q-1' });
  assert.equal(failed[0].refreshing, false);
  assert.equal(failed[0].status, 'ready');
  assert.equal(failed[0].results?.query, 'run');
});

test('dismiss drops one entry, and clear all keeps only the entries still running', () => {
  const queue = run([
    add('q-1', 'a'), { type: 'search-ready', id: 'q-1', results: result('a') },
    add('q-2', 'b'), start('q-2'),
    add('q-3', 'c'), { type: 'fail', id: 'q-3' },
    add('q-4', 'd'),
  ]);
  assert.deepEqual(searchQueueReducer(queue, { type: 'dismiss', id: 'q-1' }).map(item => item.id), ['q-2', 'q-3', 'q-4']);
  assert.deepEqual(searchQueueReducer(queue, { type: 'clear-finished' }).map(item => item.id), ['q-2', 'q-4']);
});

test('queueUpdate applies an action to the queue it is given', () => {
  const queue = run([add('q-1', 'a')]);
  assert.deepEqual(queueUpdate(start('q-1'))(queue), searchQueueReducer(queue, start('q-1')));
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
    add('q-1', 'a'), add('q-2', 'b'), start('q-2'),
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
    add('q-3', 'rot vs decay'),
  ]);
  assert.equal(isQueued(queue, 'q-3'), true, "a lookup may repeat a failed comparison's text");
  assert.equal(findLiveComparison(queue, comparisonKey(['parable', 'fable']))?.id, 'q-1');
  assert.equal(findLiveComparison(queue, comparisonKey(['decay', 'rot'])), undefined, 'and is not taken for the comparison');
});

test('a lookup of the text a live comparison shows is skipped as a duplicate', () => {
  const queue = run([{ type: 'add-compare', id: 'q-1', words: ['Fable', 'parable'], cached: null }]);
  assert.equal(hasLiveDuplicate(queue, 'fable vs parable'), true);
  assert.equal(searchQueueReducer(queue, add('q-2', 'fable vs parable')), queue);
});

test('a saved word shows its saved cards as the result, without a translation', () => {
  const cards = [vocab('run', 'verb'), vocab('run', 'noun')];
  assert.deepEqual(savedCardsResult('q-7', 'running', cards, 42), {
    id: 'saved-q-7', query: 'running', translation: '', grammar: '', visualKeyword: 'run', pronunciation: '/run/', vocabs: cards, timestamp: 42,
  });
});

test('a lookup replaced by a refresh of the same word is no longer queued', () => {
  const queue = run([add('q-1', 'gamut'), start('q-1')]);
  assert.equal(isQueued(queue, 'q-1'), true);
  const refreshed = searchQueueReducer(queue, add('q-2', 'gamut', { forceAI: true }));
  assert.equal(isQueued(refreshed, 'q-1'), false);
  assert.equal(isQueued(refreshed, 'q-2'), true);
});

test('a forced lookup of a query is noted against every request watching that query, whatever its case', () => {
  const log = createRefreshLog();
  const replaced = log.watch('Gamut');
  log.note('gamut');
  const later = log.watch('gamut');
  assert.equal(replaced(), true, 'refreshed after the watch began');
  assert.equal(later(), false, 'a watch begun after the refresh sees none');
  log.note('impasse');
  assert.equal(later(), false, "another query's refresh doesn't count");
  log.note('GAMUT');
  assert.equal(later(), true);
});

test("a forced lookup drops an entry mid-way through an in-place refresh, as the log's watch on its query reports", () => {
  const queue = run([
    add('q-1', 'gamut'), { type: 'search-ready', id: 'q-1', results: result('gamut') }, { type: 'refresh-start', id: 'q-1' },
  ]);
  const log = createRefreshLog();
  const replaced = log.watch(queue[0].query);
  log.note('Gamut');
  assert.equal(isQueued(searchQueueReducer(queue, add('q-2', 'Gamut', { forceAI: true })), 'q-1'), false);
  assert.equal(replaced(), true);
});


const ready = (id: string, query = id): QueueAction[] => [add(id, query), { type: 'search-ready', id, results: result(query) }];

test('asking again for a lookup opens it when ready, says so while it runs, and queues a new one otherwise', () => {
  const queue = run([
    ...ready('q-1', 'gamut'),
    add('q-2', 'impasse'),
    add('q-3', 'obfuscate'), start('q-3'),
    add('q-4', 'rot'), { type: 'fail', id: 'q-4' },
  ]);
  assert.equal(classifyEnqueue(queue, 'gamut'), 'open');
  assert.equal(classifyEnqueue(queue, 'impasse'), 'running', 'queued');
  assert.equal(classifyEnqueue(queue, 'obfuscate'), 'running', 'waiting on its answer');
  assert.equal(classifyEnqueue(queue, 'rot'), 'new', 'a failed lookup is asked for again');
  assert.equal(classifyEnqueue(queue, 'tangent'), 'new');
  assert.equal(classifyEnqueue([], 'gamut'), 'new');
});

test('asking again matches the lookup trimmed and whatever its case, and finds the entry to open', () => {
  const queue = run(ready('q-1', 'Gamut'));
  assert.equal(classifyEnqueue(queue, '  gAMUT '), 'open');
  assert.equal(findLiveLookup(queue, ' GAMUT')?.id, 'q-1');
  assert.equal(findLiveLookup(queue, 'gamuts'), undefined);
});

test('a comparison is never taken for a lookup of its text', () => {
  const queue = run([{ type: 'add-compare', id: 'q-1', words: ['fable', 'parable'], cached: comparison(['fable', 'parable']) }]);
  assert.equal(classifyEnqueue(queue, 'fable vs parable'), 'new');
  assert.equal(findLiveLookup(queue, 'fable vs parable'), undefined);
});

test('asking again while a lookup runs notes when, and leaves its request alone', () => {
  const queue = run([add('q-1', 'gamut'), start('q-1', 1_000), { type: 'repeat-asked', id: 'q-1', at: 2_500 }]);
  assert.deepEqual([queue[0].status, queue[0].startedAt, queue[0].repeatAt], ['searching', 1_000, 2_500]);
});

test('a result counts as new until the sheet shows it', () => {
  const queue = run([
    ...ready('q-1', 'gamut'), ...ready('q-2', 'impasse'),
    { type: 'add-compare', id: 'q-3', words: ['fable', 'parable'], cached: comparison(['fable', 'parable']) },
    add('q-4', 'rot'),
  ]);
  assert.equal(unseenReadyCount(queue), 3, 'ready lookups and comparisons, not the lookup still running');
  const shown = searchQueueReducer(queue, { type: 'mark-seen', id: 'q-2' });
  assert.equal(shown[1].seen, true);
  assert.equal(unseenReadyCount(shown), 2);
  assert.equal(unseenReadyCount(run([{ type: 'mark-seen', id: 'q-1' }, { type: 'mark-seen', id: 'q-3' }], shown)), 0);
});

test('a result refreshed in place is new again once its fresh result arrives', () => {
  const queue = run([...ready('q-1', 'run'), { type: 'mark-seen', id: 'q-1' }, { type: 'refresh-start', id: 'q-1' }]);
  assert.equal(queue[0].seen, true, 'the old result still shows, and the user saw it');
  const refreshed = searchQueueReducer(queue, { type: 'refresh-ready', id: 'q-1', query: 'run', results: result('run') });
  assert.equal(refreshed[0].seen, false);
});

test('opening the results starts at the first one not seen yet, in the order they were asked for, else the newest', () => {
  const queue = run([...ready('q-1', 'a'), ...ready('q-2', 'b'), ...ready('q-3', 'c'), { type: 'mark-seen', id: 'q-1' }]);
  assert.equal(openIndexForResults(readyItemsOf(queue)), 1);
  assert.equal(openIndexForResults(readyItemsOf(run([{ type: 'mark-seen', id: 'q-3' }], queue))), 1);
  const allSeen = run([{ type: 'mark-seen', id: 'q-2' }, { type: 'mark-seen', id: 'q-3' }], queue);
  assert.equal(openIndexForResults(readyItemsOf(allSeen)), 2, 'the newest request');
  assert.equal(openIndexForResults([]), 0);
});
