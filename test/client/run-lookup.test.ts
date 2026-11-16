import assert from 'node:assert/strict';
import test from 'node:test';
import { runLookup, type Lookup, type LookupEffects } from '../../components/search/runLookup.ts';
import { createRefreshLog } from '../../components/search/searchQueue.ts';
import { HttpError } from '../../services/http.ts';
import type { SearchResult, VocabCard } from '../../types.ts';

const vocab = (word: string, sense = ''): VocabCard => ({
  id: `${word}-${sense}`, word, sense, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [],
  confusables: [], examples: [`An example of ${word}.`], history: '', register: '', mnemonic: '',
});

const result = (query: string): SearchResult => ({
  id: `r-${query}`, query, translation: '', grammar: '', visualKeyword: query, pronunciation: '', vocabs: [vocab(query)], timestamp: 1,
});

/**
 * A lookup whose request answers only when the test says so, with effects that record what they were asked to do.
 * `library` (the saved cards when the request starts) and `current` are what savedCards and isCurrent report, so a
 * test can change them mid-request; `isCurrent` replaces the latter with a caller's own check.
 */
function harness(lookup: Partial<Lookup> = {}, saved: Record<string, VocabCard[]> = {}, isCurrent?: () => boolean) {
  let answer!: (value: SearchResult) => void;
  let refuse!: (error: unknown) => void;
  const request = new Promise<SearchResult>((resolve, reject) => { answer = resolve; refuse = reject; });
  const state = { library: new Map(Object.entries(saved)), current: true };
  const calls: string[] = [];
  const replaced: Array<[string, VocabCard[]]> = [];
  const failures: unknown[] = [];
  const effects: LookupEffects = {
    analyze: () => request,
    isCurrent: () => { calls.push('isCurrent'); return isCurrent ? isCurrent() : state.current; },
    savedCards: word => { calls.push('savedCards'); return state.library.get(word) ?? []; },
    showResult: () => calls.push('showResult'),
    showFailure: error => { calls.push('showFailure'); failures.push(error); },
    prepareAudio: () => calls.push('prepareAudio'),
    replaceSaved: (word, vocabs) => { calls.push('replaceSaved'); replaced.push([word, vocabs]); },
  };
  const settled = runLookup({ query: 'gamut', refresh: true, ...lookup }, effects);
  return { state, calls, replaced, failures, settled, answer, refuse };
}

test('nothing about the library or the queue is read until the request settles', async () => {
  const lookup = harness();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lookup.calls, []);
  lookup.answer(result('gamut'));
  await lookup.settled;
  assert.deepEqual(lookup.calls, ['isCurrent', 'showResult', 'prepareAudio', 'savedCards']);
});

test('a refresh whose card was deleted during the request leaves the library alone', async () => {
  const lookup = harness({}, { gamut: [vocab('gamut')] });
  lookup.state.library.delete('gamut');
  lookup.answer(result('gamut'));
  await lookup.settled;
  assert.deepEqual(lookup.replaced, []);
  assert.ok(lookup.calls.includes('showResult'), 'the fresh result still shows');
});

test('a refresh of a word saved during the request replaces its cards with the fresh result', async () => {
  const lookup = harness();
  lookup.state.library.set('gamut', [vocab('gamut', 'old')]);
  const fresh = result('gamut');
  lookup.answer(fresh);
  await lookup.settled;
  assert.deepEqual(lookup.replaced, [['gamut', fresh.vocabs]]);
});

test('a plain lookup of a word saved during the request never replaces its cards', async () => {
  const lookup = harness({ refresh: false });
  lookup.state.library.set('gamut', [vocab('gamut', 'old')]);
  lookup.answer(result('gamut'));
  await lookup.settled;
  assert.deepEqual(lookup.replaced, []);
  assert.deepEqual(lookup.calls, ['isCurrent', 'showResult', 'prepareAudio']);
});

test('a superseded result changes nothing: no result, no audio, no saved-card write', async () => {
  const lookup = harness({}, { gamut: [vocab('gamut')] });
  lookup.state.current = false;
  lookup.answer(result('gamut'));
  await lookup.settled;
  assert.deepEqual(lookup.calls, ['isCurrent']);
});

test('a superseded failure changes nothing: no failed entry', async () => {
  const lookup = harness();
  lookup.state.current = false;
  lookup.refuse(new Error('network down'));
  await lookup.settled;
  assert.deepEqual(lookup.calls, ['isCurrent']);
});

test('a failure marks the entry failed with the error it failed with, which the caller words and keeps', async () => {
  for (const error of [
    new HttpError('Analysis failed (503)', 503, ''),
    new HttpError('Analysis failed (422)', 422, 'No dictionary entry found.'),
    new HttpError('failed', 401, 'Session expired'), // the queue, not runLookup, keeps it to run after signing in
  ]) {
    const lookup = harness();
    lookup.refuse(error);
    await lookup.settled;
    assert.deepEqual(lookup.calls, ['isCurrent', 'showFailure'], error.message);
    assert.deepEqual(lookup.failures, [error], error.message);
  }
});

test('an in-place refresh that a forced lookup of its query replaced changes nothing; a dismissed one still saves, or reports its failure', async () => {
  // As in useSearchQueue: an in-place refresh is current until a forced lookup of its entry's query is asked for.
  const log = createRefreshLog();
  const inPlace = (saved: Record<string, VocabCard[]> = {}) => {
    const replaced = log.watch('gamut');
    return harness({}, saved, () => !replaced());
  };

  const replacedRefresh = inPlace({ gamut: [vocab('gamut')] });
  log.note('Gamut'); // the word's page refreshes it while the sheet's refresh runs, which drops the sheet's entry
  replacedRefresh.answer(result('gamut'));
  await replacedRefresh.settled;
  assert.deepEqual(replacedRefresh.calls, ['isCurrent'], 'the newer request owns the saved cards');

  // Dismissing the entry, or Clear all, asks for no lookup.
  const dismissedRefresh = inPlace({ gamut: [vocab('gamut')] });
  dismissedRefresh.answer(result('gamut'));
  await dismissedRefresh.settled;
  assert.equal(dismissedRefresh.replaced.length, 1, 'the refresh the user asked for still saves');

  const dismissedFailure = inPlace();
  dismissedFailure.refuse(new Error('network down'));
  await dismissedFailure.settled;
  assert.deepEqual(dismissedFailure.calls, ['isCurrent', 'showFailure'], 'and still reports its failure');
});
