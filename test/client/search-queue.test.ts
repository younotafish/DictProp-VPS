import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PASSING_FAILURE_MS, classifyEnqueue, createRefreshLog, findLiveComparison, findLiveLookup, finishedEntries, hasLiveDuplicate, isBusyOf, isQueued,
  nextFailureExpiry, openIndexForResults, pendingRequestsOf, queueUpdate, readyItemsOf, requestOf, runningCountOf,
  savedCardsResult, searchQueueReducer, summarizeFailures, unseenReadyCount, type QueueAction, type QueueItem,
} from '../../components/search/searchQueue.ts';
import { comparisonKey, type ComparisonResult, type SearchResult, type VocabCard } from '../../types.ts';
import type { SearchFailure } from '../../services/searchRecovery.ts';

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
  ({ type: 'add-search', id, query, forceAI: false, openOnReady: 'saved-hit', ...extra });
const start = (id: string, at = 1_000): QueueAction => ({ type: 'start', id, at });
const failure = (fields: Partial<SearchFailure> = {}): SearchFailure =>
  ({ message: 'Couldn’t reach DictProp.', retryable: true, notAWord: false, at: 1_000, ...fields });
const fail = (id: string, fields?: Partial<SearchFailure>): QueueAction => ({ type: 'fail', id, failure: failure(fields) });

test('a lookup joins the queue as pending and unseen, keeping its refresh flag, analysis mode and open policy', () => {
  assert.deepEqual(run([add('q-1', 'gamut', { analyzeMode: 'batch', openOnReady: 'never' })]), [
    { id: 'q-1', kind: 'lookup', query: 'gamut', status: 'pending', results: null, seen: false, forceAI: false, analyzeMode: 'batch', openOnReady: 'never' },
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
  const queue = run([add('q-1', 'gamut'), add('q-2', 'impasse'), fail('q-1')]);
  assert.equal(hasLiveDuplicate(queue, 'gamut'), false);
  assert.deepEqual(run([add('q-3', 'Gamut')], queue).map(item => [item.id, item.status]), [['q-2', 'pending'], ['q-3', 'pending']]);
});

test("a failed comparison stays when a lookup of its text is asked for, since it isn't that lookup", () => {
  const queue = run([{ type: 'add-compare', id: 'q-1', words: ['fable', 'parable'], cached: null }, fail('q-1')]);
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
  const settled = run([{ type: 'compare-ready', id: 'q-3', comparison: compared }, fail('q-1')], ready);
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
    { id: 'q-1', kind: 'lookup', query: 'run out', status: 'ready', results: 'run out', seen: false, forceAI: false, analyzeMode: 'batch', openOnReady: 'saved-hit', refreshing: false },
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
    add('q-3', 'c'), fail('q-3'),
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

test('the running count covers queued and running lookups and comparisons', () => {
  const queue = run([
    add('q-1', 'a'), add('q-2', 'b'), start('q-2'),
    { type: 'add-compare', id: 'q-3', words: ['x', 'y'], cached: null },
    add('q-4', 'c'), { type: 'search-ready', id: 'q-4', results: result('c') },
    add('q-5', 'd'), fail('q-5'),
  ]);
  assert.equal(runningCountOf(queue), 3);
  assert.equal(isBusyOf(queue), true);
  assert.equal(isBusyOf(run([fail('q-1'), fail('q-2'), fail('q-3')], queue)), false);
});

test('a comparison is found by its word set in any order, unless it failed', () => {
  const queue = run([
    { type: 'add-compare', id: 'q-1', words: ['Fable', 'parable'], cached: null },
    { type: 'add-compare', id: 'q-2', words: ['rot', 'decay'], cached: null }, fail('q-2'),
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
    add('q-4', 'rot'), fail('q-4'),
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

const SENTENCE = 'The gamut of emotions ran wild at the impasse.';
const scan = (id: string, query = SENTENCE): QueueAction => ({ type: 'add-scan', id, query });

test('a sentence scan joins the queue as pending, and records what it found once it finishes', () => {
  assert.deepEqual(run([scan('q-1')]), [{ id: 'q-1', kind: 'scan', query: SENTENCE, status: 'pending', results: null, seen: false }]);
  const finished = run([scan('q-1'), start('q-1', 1_000), { type: 'scan-done', id: 'q-1', found: 2, at: 4_000 }]);
  assert.deepEqual(finished, [{
    id: 'q-1', kind: 'scan', query: SENTENCE, status: 'ready', results: null, seen: false, startedAt: 1_000, found: 2, finishedAt: 4_000,
  }]);
  const chinese = run([scan('q-1', '今天天气很好，我们去公园散步吧。'), { type: 'scan-done', id: 'q-1', found: 1, translation: 'The weather is nice.', at: 2 }]);
  assert.equal(chinese[0].translation, 'The weather is nice.');
  assert.equal(run([scan('q-1'), fail('q-1')])[0].status, 'failed');
});

test('overlapping scans keep the search busy until every one of them has finished', () => {
  const both = run([scan('q-1'), scan('q-2', 'Another sentence entirely, with its own words.'), start('q-1'), start('q-2')]);
  assert.equal(isBusyOf(both), true);
  const oneLeft = run([{ type: 'scan-done', id: 'q-1', found: 0, at: 2 }], both);
  assert.equal(isBusyOf(oneLeft), true, 'the first scan finishing leaves the second running');
  assert.equal(isBusyOf(run([fail('q-2')], oneLeft)), false);
});

test('a scan is never a result, a lookup running, or something to open', () => {
  const queue = run([
    scan('q-1'), start('q-1'), { type: 'scan-done', id: 'q-1', found: 1, at: 2 },
    scan('q-2', 'A second sentence that is still being scanned.'),
    ...ready('q-3', 'gamut'),
  ]);
  assert.deepEqual(readyItemsOf(queue).map(item => item.id), ['q-3']);
  assert.equal(unseenReadyCount(queue), 1);
  assert.equal(runningCountOf(queue), 0, 'the scan still running only keeps the search busy');
  assert.equal(isBusyOf(queue), true);
});

test('the expressions a scan finds carry its id, and nothing else does', () => {
  const queue = run([scan('q-1'), add('q-2', 'gamut', { analyzeMode: 'batch', scanId: 'q-1' }), add('q-3', 'impasse')]);
  assert.equal(queue[1].scanId, 'q-1');
  assert.equal('scanId' in queue[2], false);
});

test('scanning a sentence that is still being scanned adds nothing, and a failed scan of it gives way to the new one', () => {
  const running = run([scan('q-1'), start('q-1')]);
  assert.equal(searchQueueReducer(running, scan('q-2', 'the GAMUT of emotions ran wild at the impasse.')), running, 'whatever its case');
  assert.deepEqual(run([fail('q-1'), scan('q-2')], running).map(item => [item.id, item.status]), [['q-2', 'pending']]);
  const finished = run([{ type: 'scan-done', id: 'q-1', found: 1, at: 2 }, scan('q-2')], running);
  assert.deepEqual(finished.map(item => [item.id, item.status]), [['q-1', 'ready'], ['q-2', 'pending']], 'a finished scan can be run again');
});

test('clear all drops finished and failed scans and keeps the ones still running', () => {
  const queue = run([
    scan('q-1'), { type: 'scan-done', id: 'q-1', found: 0, at: 2 },
    scan('q-2', 'A sentence still being scanned, a long one.'), start('q-2'),
    scan('q-3', 'A sentence whose scan failed, sadly enough.'), fail('q-3'),
    ...ready('q-4', 'gamut'),
  ]);
  assert.deepEqual(searchQueueReducer(queue, { type: 'clear-finished' }).map(item => item.id), ['q-2']);
});

test('a lookup never takes a scan of the same text for a duplicate, and a refresh leaves it running', () => {
  const queue = run([scan('q-1'), start('q-1')]);
  assert.equal(hasLiveDuplicate(queue, SENTENCE), false);
  assert.equal(classifyEnqueue(queue, SENTENCE), 'new');
  assert.equal(findLiveLookup(queue, SENTENCE), undefined);
  assert.deepEqual(run([add('q-2', SENTENCE)], queue).map(item => [item.id, item.kind]), [['q-1', 'scan'], ['q-2', 'lookup']]);
  assert.deepEqual(run([add('q-2', SENTENCE, { forceAI: true })], queue).map(item => [item.id, item.kind]), [['q-1', 'scan'], ['q-2', 'lookup']]);
});

test('a failed request keeps why on its entry', () => {
  const why = failure({ message: 'No dictionary entry found for “qwxzv”.', retryable: false, notAWord: true, at: 7 });
  const [entry] = run([add('q-1', 'qwxzv'), start('q-1'), { type: 'fail', id: 'q-1', failure: why }]);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.failure, why);
});

test('with no failures the error toast has nothing to show', () => {
  assert.equal(summarizeFailures(run([...ready('q-1', 'gamut'), add('q-2', 'impasse')]), 0), null);
  assert.equal(summarizeFailures([], 0), null);
});

test('the toast leads with the newest failure, counts the others, and offers Retry all when several could work', () => {
  const queue = run([
    add('q-1', 'gamut'), fail('q-1', { at: 1_000, message: 'Couldn’t reach DictProp for “gamut”.' }),
    { type: 'add-compare', id: 'q-2', words: ['fable', 'parable'], cached: null }, fail('q-2', { at: 3_000, message: 'Couldn’t reach DictProp for “fable vs parable”.' }),
    { type: 'add-scan', id: 'q-3', query: SENTENCE }, fail('q-3', { at: 2_000 }),
    ...ready('q-4', 'impasse'),
  ]);
  const summary = summarizeFailures(queue, 3_500);
  assert.equal(summary?.newest.id, 'q-2');
  assert.equal(summary?.newest.failure.message, 'Couldn’t reach DictProp for “fable vs parable”.');
  assert.equal(summary?.others, 2);
  assert.equal(summary?.action, 'retry-all');
});

test('the action follows the newest failure: Retry for the only one that could work, Edit for a word not found, else none', () => {
  const one = run([add('q-1', 'gamut'), fail('q-1')]);
  assert.equal(summarizeFailures(one, 0)?.action, 'retry');

  const notAWord = run([add('q-1', 'gamut'), fail('q-1', { at: 1 }), add('q-2', 'qwxzv'), fail('q-2', { at: 2, retryable: false, notAWord: true })]);
  assert.deepEqual([summarizeFailures(notAWord, 2)?.newest.id, summarizeFailures(notAWord, 2)?.action], ['q-2', 'edit']);

  const refused = run([add('q-1', 'gamut'), fail('q-1', { at: 1 }), add('q-2', 'x'.repeat(30)), fail('q-2', { at: 2, retryable: false })]);
  assert.deepEqual([summarizeFailures(refused, 2)?.newest.id, summarizeFailures(refused, 2)?.action, summarizeFailures(refused, 2)?.others], ['q-2', null, 1]);

  const olderRetryable = run([add('q-1', 'qwxzv'), fail('q-1', { at: 1, retryable: false, notAWord: true }), add('q-2', 'gamut'), fail('q-2', { at: 2 })]);
  assert.equal(summarizeFailures(olderRetryable, 2)?.action, 'retry', 'only one of them could work');
});

test('a failure neither Retry nor Edit could fix leaves the toast after 6 s; the others stay until acted on', () => {
  const queue = run([
    add('q-1', 'gamut'), fail('q-1', { at: 1_000 }),
    add('q-2', 'qwxzv'), fail('q-2', { at: 2_000, retryable: false, notAWord: true }),
    add('q-3', 'Text that is too long'), fail('q-3', { at: 3_000, retryable: false }),
    add('q-4', 'Another refused text'), fail('q-4', { at: 4_000, retryable: false }),
  ]);
  assert.equal(nextFailureExpiry(queue, 4_000), 3_000 + PASSING_FAILURE_MS);
  assert.equal(summarizeFailures(queue, 4_000)?.others, 3);
  assert.equal(nextFailureExpiry(queue, 3_000 + PASSING_FAILURE_MS), 4_000 + PASSING_FAILURE_MS);
  const later = summarizeFailures(queue, 3_000 + PASSING_FAILURE_MS);
  assert.deepEqual([later?.newest.id, later?.others], ['q-4', 2]);
  const muchLater = summarizeFailures(queue, 60_000);
  assert.deepEqual([muchLater?.newest.id, muchLater?.others, muchLater?.action], ['q-2', 1, 'edit']);
  assert.equal(nextFailureExpiry(queue, 60_000), null);
  assert.equal(nextFailureExpiry(run([add('q-1', 'gamut'), fail('q-1')]), 0), null, 'a failure retrying could fix never leaves by itself');
});

test('Retry all runs every failure that retrying could fix again, in place and in its own mode', () => {
  const queue = run([
    add('q-1', 'gamut', { analyzeMode: 'batch', scanId: 'q-9', openOnReady: 'never' }), start('q-1', 10), { type: 'repeat-asked', id: 'q-1', at: 20 }, fail('q-1'),
    ...ready('q-2', 'impasse'),
    add('q-3', 'run', { forceAI: true, openOnReady: 'any' }), fail('q-3'),
    { type: 'add-compare', id: 'q-4', words: ['fable', 'parable'], cached: null }, fail('q-4'),
    { type: 'add-scan', id: 'q-5', query: SENTENCE }, fail('q-5'),
    add('q-6', 'qwxzv'), fail('q-6', { retryable: false, notAWord: true }),
  ]);
  const retried = searchQueueReducer(queue, { type: 'retry-failed' });
  assert.deepEqual(retried.map(item => [item.id, item.status]), [
    ['q-1', 'pending'], ['q-2', 'ready'], ['q-3', 'pending'], ['q-4', 'pending'], ['q-5', 'pending'], ['q-6', 'failed'],
  ]);
  assert.deepEqual(retried[0], {
    id: 'q-1', kind: 'lookup', query: 'gamut', status: 'pending', results: null, seen: false, forceAI: false,
    analyzeMode: 'batch', openOnReady: 'never', scanId: 'q-9',
  }, 'as it was asked for: no failure, and no request out yet');
  assert.deepEqual([retried[2].forceAI, retried[2].openOnReady], [true, 'any']);
  assert.deepEqual([retried[3].kind, retried[3].words], ['compare', ['fable', 'parable']]);
  assert.equal(retried[4].kind, 'scan');
  assert.equal(retried[1], queue[1], 'the others are left as they were');
  assert.equal(retried[5], queue[5]);
});

test('× drops every failed entry and keeps the rest', () => {
  const queue = run([add('q-1', 'gamut'), fail('q-1'), ...ready('q-2', 'impasse'), add('q-3', 'rot'), add('q-4', 'qwxzv'), fail('q-4', { retryable: false, notAWord: true })]);
  assert.deepEqual(searchQueueReducer(queue, { type: 'dismiss-failed' }).map(item => item.id), ['q-2', 'q-3']);
});

test('a failed comparison gives way to the same comparison asked for again, so a retry never runs it twice', () => {
  const queue = run([{ type: 'add-compare', id: 'q-1', words: ['fable', 'parable'], cached: null }, fail('q-1'), add('q-2', 'gamut'), fail('q-2')]);
  const again = searchQueueReducer(queue, { type: 'add-compare', id: 'q-3', words: ['Parable', 'fable'], cached: null });
  assert.deepEqual(again.map(item => [item.id, item.status]), [['q-2', 'failed'], ['q-3', 'pending']]);
});

test('each entry stands for the request that runs it again: its query and mode, never its result', () => {
  const queue = run([
    ...ready('q-1', 'gamut'),
    add('q-2', 'run the gamut', { analyzeMode: 'batch', scanId: 'q-9', openOnReady: 'never' }),
    add('q-3', 'impasse', { forceAI: true, openOnReady: 'any' }),
    { type: 'add-compare', id: 'q-4', words: ['fable', 'parable'], cached: comparison(['fable', 'parable']) },
    { type: 'add-scan', id: 'q-5', query: SENTENCE },
  ]);
  assert.deepEqual(queue.map(requestOf), [
    { kind: 'analyze', query: 'gamut' },
    { kind: 'analyze', query: 'run the gamut', analyzeMode: 'batch' },
    { kind: 'analyze', query: 'impasse', forceAI: true },
    { kind: 'compare', words: ['fable', 'parable'] },
    { kind: 'scan', query: SENTENCE },
  ]);
});

test('a reload would lose the requests still running and the results not seen yet, with when each went out', () => {
  const queue = run([
    add('q-1', 'gamut'), start('q-1', 1_000),
    add('q-2', 'impasse'),
    ...ready('q-3', 'rot'), { type: 'mark-seen', id: 'q-3' },
    ...ready('q-4', 'tangent'),
    add('q-5', 'qwxzv'), fail('q-5'),
    { type: 'add-scan', id: 'q-6', query: SENTENCE }, start('q-6', 2_000),
    { type: 'add-scan', id: 'q-7', query: 'A finished sentence, with its expressions queued.' }, { type: 'scan-done', id: 'q-7', found: 1, at: 3 },
    { type: 'add-compare', id: 'q-8', words: ['fable', 'parable'], cached: comparison(['fable', 'parable']) },
  ]);
  assert.deepEqual(pendingRequestsOf(queue, 9_000), [
    { request: { kind: 'analyze', query: 'gamut' }, at: 1_000 },
    { request: { kind: 'analyze', query: 'impasse' }, at: 9_000 },
    { request: { kind: 'analyze', query: 'tangent' }, at: 9_000 },
    { request: { kind: 'scan', query: SENTENCE }, at: 2_000 },
    { request: { kind: 'compare', words: ['fable', 'parable'] }, at: 9_000 },
  ]);
  assert.deepEqual(pendingRequestsOf([], 0), []);
});

test('a lookup keeps the sentence it came from, through a refresh in place, but never in the request run again', () => {
  const queue = run([add('q-1', 'gamut', { context: 'It ran the gamut.' }), { type: 'search-ready', id: 'q-1', results: result('gamut') }]);
  assert.equal(queue[0].context, 'It ran the gamut.');
  const refreshed = run([{ type: 'refresh-start', id: 'q-1' }, { type: 'refresh-ready', id: 'q-1', query: 'gamut', results: result('gamut') }], queue);
  assert.equal(refreshed[0].context, 'It ran the gamut.');
  assert.deepEqual(requestOf(queue[0]), { kind: 'analyze', query: 'gamut' });
  assert.deepEqual(pendingRequestsOf(queue, 5), [{ request: { kind: 'analyze', query: 'gamut' }, at: 5 }]);
  assert.equal('context' in run([add('q-2', 'impasse')])[0], false, 'a lookup without one carries none');
});

/** A tray before Clear all: a seen result, an unseen comparison, a failure, a finished scan and a lookup still running. */
const trayBeforeClearAll = (): QueueItem[] => run([
  ...ready('q-1', 'gamut'), { type: 'mark-seen', id: 'q-1' },
  { type: 'add-compare', id: 'q-2', words: ['fable', 'parable'], cached: comparison(['fable', 'parable']) },
  add('q-3', 'impasse'), fail('q-3', { notAWord: true, retryable: false }),
  scan('q-4'), { type: 'scan-done', id: 'q-4', found: 1, at: 2 },
  add('q-5', 'tenuous'), start('q-5'),
]);

test('Clear all drops exactly the finished entries: results, failures and finished scans', () => {
  const queue = trayBeforeClearAll();
  assert.deepEqual(finishedEntries(queue).map(item => item.id), ['q-1', 'q-2', 'q-3', 'q-4']);
  const cleared = searchQueueReducer(queue, { type: 'clear-finished' });
  assert.deepEqual([...finishedEntries(queue), ...cleared].map(item => item.id).sort(), queue.map(item => item.id).sort());
  assert.deepEqual(finishedEntries(cleared), []);
});

test('undoing Clear all puts the entries back as they were, in the order they were asked for, ahead of the running ones', () => {
  const queue = trayBeforeClearAll();
  const removed = finishedEntries(queue);
  const restored = run([{ type: 'clear-finished' }, { type: 'restore', entries: removed }], queue);
  assert.deepEqual(restored.map(item => item.id), ['q-1', 'q-2', 'q-3', 'q-5'], 'the finished scan stays out');
  assert.deepEqual(restored.slice(0, 3), queue.slice(0, 3), 'seen flags, results and failures included');
  assert.equal(summarizeFailures(restored, 1_000)?.newest.id, 'q-3');
  assert.equal(unseenReadyCount(restored), 1);
});

test('entries put back go ahead of the entries asked for since Clear all', () => {
  const queue = run(ready('q-1', 'gamut'));
  const restored = run([{ type: 'clear-finished' }, ...ready('q-2', 'impasse'), { type: 'restore', entries: finishedEntries(queue) }], queue);
  assert.deepEqual(restored.map(item => item.id), ['q-1', 'q-2']);
});

test('an entry asked for again since Clear all is not put back beside it', () => {
  const queue = run([...ready('q-1', 'gamut'), { type: 'add-compare', id: 'q-2', words: ['fable', 'parable'], cached: comparison(['fable', 'parable']) }]);
  const removed = finishedEntries(queue);
  const askedAgain = run([{ type: 'clear-finished' }, add('q-3', 'Gamut'), { type: 'add-compare', id: 'q-4', words: ['parable', 'fable'], cached: null }], queue);
  assert.deepEqual(run([{ type: 'restore', entries: removed }], askedAgain).map(item => item.id), ['q-3', 'q-4']);
});

test('a result put back replaces a failure of the same request since, but a failure never doubles one', () => {
  const queue = run([...ready('q-1', 'gamut'), add('q-2', 'impasse'), fail('q-2')]);
  const removed = finishedEntries(queue);
  const failedAgain = run([{ type: 'clear-finished' }, add('q-3', 'gamut'), fail('q-3'), add('q-4', 'impasse'), fail('q-4')], queue);
  assert.deepEqual(run([{ type: 'restore', entries: removed }], failedAgain).map(item => [item.id, item.status]), [['q-1', 'ready'], ['q-4', 'failed']]);
});

test('an entry is put back without the refresh it was showing, and restoring twice puts nothing back twice', () => {
  const queue = run([...ready('q-1', 'gamut'), { type: 'refresh-start', id: 'q-1' }]);
  const removed = finishedEntries(queue);
  const restored = run([{ type: 'clear-finished' }, { type: 'restore', entries: removed }], queue);
  assert.equal('refreshing' in restored[0], false);
  assert.equal(searchQueueReducer(restored, { type: 'restore', entries: removed }), restored);
  assert.deepEqual(searchQueueReducer([], { type: 'restore', entries: [] }), []);
});
