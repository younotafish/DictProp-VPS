import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, TimeoutError } from '../../services/http.ts';
import {
  consumeSearchRetry, describeSearchError, isNetworkFailure, isRetryableSearchError, rememberSearchRetry, type SearchSubject,
} from '../../services/searchRecovery.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

test('expired-session searches survive an OAuth redirect and retain a useful error', () => {
  const storage = new MemoryStorage();
  rememberSearchRetry({ query: 'visceral', analyzeMode: 'batch' }, storage);

  assert.deepEqual(consumeSearchRetry(storage), { query: 'visceral', analyzeMode: 'batch' });
  assert.equal(consumeSearchRetry(storage), null);
  assert.match(
    describeSearchError('visceral', new HttpError('failed', 401, 'Session expired')),
    /session expired/i,
  );
});

test('search errors explain not-found, quota and rate limits distinctly', () => {
  assert.equal(
    describeSearchError('qwxzv', new HttpError('Analysis failed (422)', 422, 'No dictionary entry found. Check the spelling and try again.')),
    'No dictionary entry found for "qwxzv". Check the spelling and try again.',
  );
  assert.equal(
    describeSearchError('bank', new HttpError('Analysis failed (429)', 429, 'QUOTA_EXCEEDED')),
    'The AI provider quota is exhausted. Please try again later.',
  );
  assert.equal(
    describeSearchError('bank', new HttpError('Analysis failed (429)', 429, 'RATE_LIMITED')),
    'The AI provider rate-limited this request. Try again shortly.',
  );
  assert.equal(describeSearchError('bank', new Error('QUOTA_EXCEEDED')), 'The AI provider quota is exhausted. Please try again later.');
  assert.match(describeSearchError('bank', new HttpError('Analysis failed (502)', 502, '')), /no usable definition/);
});

test('a search is offered again only when repeating it could succeed', () => {
  assert.equal(isRetryableSearchError(new HttpError('Analysis failed (422)', 422, 'No dictionary entry found.')), false);
  assert.equal(isRetryableSearchError(new HttpError('Analysis failed (400)', 400, 'Text is too long')), false);
  assert.equal(isRetryableSearchError(new HttpError('failed', 401, 'Session expired')), true);
  assert.equal(isRetryableSearchError(new HttpError('Analysis failed (429)', 429, 'RATE_LIMITED')), true);
  assert.equal(isRetryableSearchError(new HttpError('Analysis failed (504)', 504, '')), true);
  assert.equal(isRetryableSearchError(new Error('The model did not finish this search before the timeout.')), true);
  // The toast adds the retry prompt itself, so the message doesn't repeat it.
  assert.doesNotMatch(describeSearchError('bank', new HttpError('Analysis failed (504)', 504, '')), /retry/i);
});

const lookup = (label: string): SearchSubject => ({ kind: 'analysis', label });
const comparison = (label: string): SearchSubject => ({ kind: 'comparison', label });
const scan = (label: string): SearchSubject => ({ kind: 'scan', label });
const networkDown = () => new Error('Failed to fetch', { cause: new TypeError('Failed to fetch') });

test('a request that never reached DictProp says so, for a lookup, a comparison and a scan', () => {
  assert.equal(describeSearchError(lookup('gamut'), networkDown()), 'Couldn’t reach DictProp for “gamut”.');
  assert.equal(describeSearchError(lookup('gamut'), new TypeError('Load failed')), 'Couldn’t reach DictProp for “gamut”.', 'as thrown');
  assert.equal(describeSearchError(comparison('fable vs parable'), networkDown()), 'Couldn’t reach DictProp for “fable vs parable”.');
  assert.equal(describeSearchError(scan('It ran the gamut.'), new TypeError('Failed to fetch')), 'Couldn’t reach DictProp to scan “It ran the gamut.”.');
});

test('a timeout says the model did not finish, by its name or a 504', () => {
  const timedOut = 'The model did not finish “gamut” before the timeout.';
  assert.equal(describeSearchError(lookup('gamut'), new TimeoutError('The model did not finish this search before the timeout. Please retry it.')), timedOut);
  assert.equal(describeSearchError(lookup('gamut'), new DOMException('The operation was aborted.', 'AbortError')), timedOut);
  assert.equal(describeSearchError(lookup('gamut'), new HttpError('Analysis failed (504)', 504, '')), timedOut);
  assert.equal(describeSearchError(scan('It ran the gamut.'), new TimeoutError()), 'The model did not finish “It ran the gamut.” before the timeout.');
});

test('the server\'s statuses keep their own words, a 502 in each kind\'s', () => {
  assert.equal(describeSearchError(lookup('gamut'), new HttpError('failed', 502, '')), 'The model returned no usable definition for “gamut”.');
  assert.equal(describeSearchError(comparison('fable vs parable'), new HttpError('failed', 502, '')), 'The model returned no usable comparison for “fable vs parable”.');
  assert.equal(describeSearchError(scan('It ran the gamut.'), new HttpError('failed', 502, '')), 'The model found no usable expressions in this text.');
  assert.equal(describeSearchError(lookup('gamut'), new HttpError('failed', 503, '')), 'The AI provider is temporarily unavailable for “gamut”.');
  assert.equal(describeSearchError(lookup('qwxzv'), new HttpError('failed', 422, 'Not a word')), 'No dictionary entry found for “qwxzv”. Check the spelling and try again.');
  assert.equal(describeSearchError(lookup('gamut'), new HttpError('failed', 401, 'Session expired')), 'Your session expired. Sign in again to retry “gamut”.');
  assert.equal(describeSearchError(scan('Lorem ipsum'), new HttpError('failed', 400, 'Text is too long.')), 'Could not scan “Lorem ipsum”: Text is too long.');
  assert.equal(describeSearchError(comparison('a vs b'), new HttpError('failed', 400, 'Please provide at least 2 different words to compare.')),
    'Could not compare “a vs b”: Please provide at least 2 different words to compare.');
  for (const subject of [lookup('bank'), comparison('a vs b'), scan('A sentence.')]) {
    assert.equal(describeSearchError(subject, new HttpError('failed', 429, 'QUOTA_EXCEEDED')), 'The AI provider quota is exhausted. Please try again later.');
    assert.equal(describeSearchError(subject, new Error('QUOTA_EXCEEDED')), 'The AI provider quota is exhausted. Please try again later.');
    assert.equal(describeSearchError(subject, new HttpError('failed', 429, 'RATE_LIMITED')), 'The AI provider rate-limited this request. Try again shortly.');
  }
});

test('anything else could not be done, in the words of what was asked', () => {
  assert.equal(describeSearchError(lookup('gamut'), new Error('Search failed. Please try again.')), 'Could not analyze “gamut”.');
  assert.equal(describeSearchError(comparison('fable vs parable'), undefined), 'Could not compare “fable vs parable”.');
  assert.equal(describeSearchError(scan('It ran the gamut.'), new SyntaxError('Unexpected token')), 'Could not scan “It ran the gamut.”.');
});

test('an error quotes at most 40 characters of what was asked, on one line, with an ellipsis when it cuts', () => {
  const sentence = 'The committee could not reach a consensus, so the meeting ran on.';
  assert.equal(describeSearchError(scan(sentence), networkDown()), 'Couldn’t reach DictProp to scan “The committee could not reach a consensu…”.');
  assert.equal(describeSearchError(lookup('x'.repeat(40)), networkDown()), `Couldn’t reach DictProp for “${'x'.repeat(40)}”.`, 'exactly 40 stays whole');
  assert.equal(describeSearchError(scan('Line one.\n\n  Line   two.'), networkDown()), 'Couldn’t reach DictProp to scan “Line one. Line two.”.');
  assert.equal(describeSearchError(lookup(`${'字'.repeat(39)}😀😀`), networkDown()), `Couldn’t reach DictProp for “${'字'.repeat(39)}😀…”.`, 'counting characters, not code units');
});

test('a network failure is found through the causes of the errors wrapping it, and only there', () => {
  assert.equal(isNetworkFailure(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkFailure(networkDown()), true);
  assert.equal(isNetworkFailure(new Error('outer', { cause: networkDown() })), true);
  assert.equal(isNetworkFailure(new Error('Search failed.')), false);
  assert.equal(isNetworkFailure(new HttpError('failed', 503, '')), false);
  assert.equal(isNetworkFailure(new TimeoutError()), false);
  assert.equal(isNetworkFailure('Failed to fetch'), false);
  assert.equal(isNetworkFailure(undefined), false);
});

test('a plain query keeps the wording it had before subjects, for the callers that still pass one', () => {
  assert.equal(describeSearchError('bank', networkDown()), 'Could not analyze "bank".');
  assert.equal(describeSearchError('bank', new HttpError('failed', 503, '')), 'The AI provider is temporarily unavailable for "bank".');
  assert.equal(describeSearchError('bank', new Error('Request timed out')), 'The model did not finish "bank" before the timeout.');
});
