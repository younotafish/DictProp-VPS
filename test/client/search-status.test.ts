import assert from 'node:assert/strict';
import test from 'node:test';
import { searchQueueReducer, type QueueAction, type QueueItem } from '../../components/search/searchQueue.ts';
import {
  LOOKUP_LINE_MS, SCAN_DONE_LINE_MS, deriveSearchStatus, nextStatusChangeAt,
} from '../../components/search/searchStatusLine.ts';
import type { SearchResult } from '../../types.ts';

const run = (actions: QueueAction[]): QueueItem[] => actions.reduce(searchQueueReducer, []);
const add = (id: string, query: string, extra: Partial<Extract<QueueAction, { type: 'add-search' }>> = {}): QueueAction =>
  ({ type: 'add-search', id, query, forceAI: false, openOnReady: 'saved-hit', ...extra });
const start = (id: string, at: number): QueueAction => ({ type: 'start', id, at });
const result = (query: string): SearchResult => ({
  id: `r-${query}`, query, translation: '', grammar: '', visualKeyword: query, pronunciation: '', vocabs: [], timestamp: 1,
});
const ready = (id: string, query: string, at = 1_000): QueueAction[] =>
  [add(id, query), start(id, at), { type: 'search-ready', id, results: result(query) }];
const SENTENCE = 'The gamut of emotions ran wild at the impasse.';
const scan = (id: string, query = SENTENCE): QueueAction => ({ type: 'add-scan', id, query });
const text = (queue: QueueItem[], now: number) => deriveSearchStatus(queue, now)?.text ?? null;

test('a lookup says it is looking up for 2 s after its request goes out, and nothing after', () => {
  const queue = run([add('q-1', 'gamut'), start('q-1', 10_000)]);
  assert.deepEqual(deriveSearchStatus(queue, 10_000), { kind: 'started', text: 'Looking up “gamut”…' });
  assert.equal(text(queue, 10_000 + LOOKUP_LINE_MS - 1), 'Looking up “gamut”…');
  assert.equal(text(queue, 10_000 + LOOKUP_LINE_MS), null);
});

test('a saved word, answered at once without a request, never says it is looking up', () => {
  const saved = run([add('q-1', 'gamut'), { type: 'search-ready', id: 'q-1', results: result('gamut') }, { type: 'mark-seen', id: 'q-1' }]);
  assert.equal(deriveSearchStatus(saved, 0), null);
  assert.equal(text(run([add('q-1', 'gamut')]), 0), null, 'nor one still waiting for its request to go out');
});

test('asking again for a lookup still running says so, as the newest line', () => {
  const queue = run([add('q-1', 'gamut'), start('q-1', 10_000), { type: 'repeat-asked', id: 'q-1', at: 11_000 }]);
  assert.deepEqual(deriveSearchStatus(queue, 11_500), { kind: 'repeat', text: 'Still looking up “gamut”…' });
  assert.equal(text(queue, 11_000 + LOOKUP_LINE_MS), null);
});

test('a scan says "Scanning…" once, however many run, and its expressions never get a line each', () => {
  const queue = run([
    scan('q-1'), start('q-1', 10_000),
    scan('q-2', 'Another sentence entirely, with words of its own.'), start('q-2', 10_500),
    add('q-3', 'gamut', { analyzeMode: 'batch', scanId: 'q-9', openOnReady: 'never' }), start('q-3', 10_600),
  ]);
  assert.deepEqual(deriveSearchStatus(queue, 10_700), { kind: 'scanning', text: 'Scanning…' });
  assert.deepEqual(deriveSearchStatus(queue, 60_000), { kind: 'scanning', text: 'Scanning…' }, 'and keeps saying it while one runs');
});

test('a finished scan says what it found for 3.5 s: how many, in English when it read Chinese, or nothing advanced', () => {
  const found = run([scan('q-1'), start('q-1', 1_000), { type: 'scan-done', id: 'q-1', found: 4, at: 5_000 }]);
  assert.deepEqual(deriveSearchStatus(found, 5_000), { kind: 'scan-done', text: 'Found 4 expressions — analyzing…' });
  assert.equal(text(found, 5_000 + SCAN_DONE_LINE_MS), null);
  const one = run([scan('q-1'), { type: 'scan-done', id: 'q-1', found: 1, at: 5_000 }]);
  assert.equal(text(one, 5_000), 'Found 1 expression — analyzing…');
  const chinese = run([scan('q-1', '他们的情绪起伏很大。'), { type: 'scan-done', id: 'q-1', found: 2, translation: 'Their emotions ran the gamut.', at: 5_000 }]);
  assert.equal(text(chinese, 5_000), '“Their emotions ran the gamut.” — analyzing 2 expressions…');
  const none = run([scan('q-1'), { type: 'scan-done', id: 'q-1', found: 0, at: 5_000 }]);
  assert.equal(text(none, 5_000), 'No advanced expressions in this sentence');
});

test('a result not seen yet stays as its word with View, counting the others, until it is seen', () => {
  const queue = run([...ready('q-1', 'gamut'), ...ready('q-2', 'impasse'), ...ready('q-3', 'rot')]);
  assert.deepEqual(deriveSearchStatus(queue, 60_000), { kind: 'ready', text: 'gamut +2', viewId: 'q-1' });
  const firstSeen = searchQueueReducer(queue, { type: 'mark-seen', id: 'q-1' });
  assert.deepEqual(deriveSearchStatus(firstSeen, 60_000), { kind: 'ready', text: 'impasse +1', viewId: 'q-2' });
  const allSeen = (['q-2', 'q-3'] as const).reduce((seen, id) => searchQueueReducer(seen, { type: 'mark-seen', id }), firstSeen);
  assert.equal(deriveSearchStatus(allSeen, 60_000), null);
});

test('the ready line names the result as the AI read it, and a comparison by its words', () => {
  const corrected = run([add('q-1', 'gamutt'), start('q-1', 1), { type: 'search-ready', id: 'q-1', results: result('gamut') }]);
  assert.equal(text(corrected, 60_000), 'gamut');
  const compared = run([{ type: 'add-compare', id: 'q-1', words: ['fable', 'parable'], cached: null }, start('q-1', 1),
    { type: 'compare-ready', id: 'q-1', comparison: { words: ['fable', 'parable'], summary: '', dimensions: [], examples: [], commonMistakes: [], verdict: '' } }]);
  assert.deepEqual(deriveSearchStatus(compared, 60_000), { kind: 'ready', text: 'fable vs parable', viewId: 'q-1' });
});

test('a ready result shows while other lookups run, a moment line wins inside its window, and a running scan comes last', () => {
  const looking = run([...ready('q-1', 'gamut', 1_000), add('q-2', 'impasse'), start('q-2', 20_000)]);
  assert.equal(text(looking, 20_400), 'Looking up “impasse”…');
  assert.equal(text(looking, 22_000), 'gamut', 'then the result not seen yet, while the lookup still runs');
  const scanning = run([...ready('q-1', 'gamut', 1_000), add('q-2', 'impasse'), start('q-2', 20_000), scan('q-3'), start('q-3', 20_500)]);
  assert.equal(text(scanning, 20_600), 'Scanning…', 'the newest moment line: the scan started later');
  assert.equal(text(scanning, 30_000), 'gamut');
  const seen = searchQueueReducer(scanning, { type: 'mark-seen', id: 'q-1' });
  assert.equal(text(seen, 30_000), 'Scanning…');
});

test('worked out at a time before a moment it reports, a line still shows: the clock only lags behind what happened', () => {
  const queue = run([add('q-1', 'gamut'), start('q-1', 50_000)]);
  assert.equal(text(queue, 1_000), 'Looking up “gamut”…');
  assert.equal(nextStatusChangeAt(queue, 1_000), 50_000 + LOOKUP_LINE_MS);
});

test('the next change is when the soonest line still showing runs out, or none', () => {
  const queue = run([add('q-1', 'gamut'), start('q-1', 10_000), scan('q-2'), start('q-2', 10_500), { type: 'scan-done', id: 'q-2', found: 1, at: 11_000 }]);
  assert.equal(nextStatusChangeAt(queue, 10_000), 10_000 + LOOKUP_LINE_MS);
  assert.equal(nextStatusChangeAt(queue, 10_000 + LOOKUP_LINE_MS), 11_000 + SCAN_DONE_LINE_MS);
  assert.equal(nextStatusChangeAt(queue, 11_000 + SCAN_DONE_LINE_MS), null);
  assert.equal(nextStatusChangeAt(run([...ready('q-1', 'gamut')]), 60_000), null, 'a ready line changes only with the queue');
});
