import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../../services/http.ts';
import { consumeSearchRetry, describeSearchError, isRetryableSearchError, rememberSearchRetry } from '../../services/searchRecovery.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

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
