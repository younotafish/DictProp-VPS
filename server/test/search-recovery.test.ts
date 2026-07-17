import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../../services/http.ts';
import { consumeSearchRetry, describeSearchError, rememberSearchRetry } from '../../services/searchRecovery.ts';

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
