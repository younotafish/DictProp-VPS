import assert from 'node:assert/strict';
import test from 'node:test';
import { runLookup, type Lookup, type LookupEffects } from '../../components/search/runLookup.ts';
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
 * test can change them mid-request.
 */
function harness(lookup: Partial<Lookup> = {}, saved: Record<string, VocabCard[]> = {}) {
  let answer!: (value: SearchResult) => void;
  let refuse!: (error: unknown) => void;
  const request = new Promise<SearchResult>((resolve, reject) => { answer = resolve; refuse = reject; });
  const state = { library: new Map(Object.entries(saved)), current: true };
  const calls: string[] = [];
  const replaced: Array<[string, VocabCard[]]> = [];
  const errors: Array<[string, string | undefined]> = [];
  const effects: LookupEffects = {
    analyze: () => request,
    isCurrent: () => { calls.push('isCurrent'); return state.current; },
    savedCards: word => { calls.push('savedCards'); return state.library.get(word) ?? []; },
    showResult: () => calls.push('showResult'),
    showFailure: () => calls.push('showFailure'),
    prepareAudio: () => calls.push('prepareAudio'),
    replaceSaved: (word, vocabs) => { calls.push('replaceSaved'); replaced.push([word, vocabs]); },
    showError: (message, retryQuery) => { calls.push('showError'); errors.push([message, retryQuery]); },
  };
  const settled = runLookup({ query: 'gamut', refresh: true, ...lookup }, effects);
  return { state, calls, replaced, errors, settled, answer, refuse };
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

test('a superseded failure changes nothing: no failed entry, no toast', async () => {
  const lookup = harness();
  lookup.state.current = false;
  lookup.refuse(new Error('network down'));
  await lookup.settled;
  assert.deepEqual(lookup.calls, ['isCurrent']);
});

test('a failure marks the entry failed and shows the toast, offering a retry only when one could help', async () => {
  const retryable = harness();
  retryable.refuse(new HttpError('Analysis failed (503)', 503, ''));
  await retryable.settled;
  assert.deepEqual(retryable.calls, ['isCurrent', 'showFailure', 'showError']);
  assert.deepEqual(retryable.errors, [['The AI provider is temporarily unavailable for "gamut".', 'gamut']]);

  const final = harness();
  final.refuse(new HttpError('Analysis failed (422)', 422, 'No dictionary entry found.'));
  await final.settled;
  assert.deepEqual(final.errors, [['No dictionary entry found for "gamut". Check the spelling and try again.', undefined]]);
});
