import assert from 'node:assert/strict';
import test from 'node:test';
import { readCachedComparisons, writeCachedComparisons } from '../../components/search/storedComparisons.ts';
import type { StoredComparison } from '../../types.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

const comparison = (key: string, updatedAt: number): StoredComparison => ({
  key,
  words: key.split('|'),
  data: { words: key.split('|'), summary: 's', dimensions: [], examples: [], commonMistakes: [], verdict: 'v' },
  updatedAt,
});

test('each user keeps their own comparison list on the device', () => {
  const storage = new MemoryStorage();
  writeCachedComparisons('user-a', [comparison('fable|parable', 1)], storage);
  writeCachedComparisons('user-b', [comparison('decay|rot', 2)], storage);

  assert.deepEqual(readCachedComparisons('user-a', storage), [comparison('fable|parable', 1)]);
  assert.deepEqual(readCachedComparisons('user-b', storage), [comparison('decay|rot', 2)]);
  assert.equal(storage.getItem('vps_comparisons_cache_user-a'), JSON.stringify([comparison('fable|parable', 1)]));
});

test('a missing, unreadable or non-list cache reads as nothing', () => {
  const storage = new MemoryStorage();
  assert.equal(readCachedComparisons('user-a', storage), null);
  storage.setItem('vps_comparisons_cache_user-a', '{not json');
  assert.equal(readCachedComparisons('user-a', storage), null);
  storage.setItem('vps_comparisons_cache_user-a', '{"key":"a|b"}');
  assert.equal(readCachedComparisons('user-a', storage), null);
});

test('storage that refuses a write or a read is ignored', () => {
  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.doesNotThrow(() => writeCachedComparisons('user-a', [comparison('a|b', 1)], broken));
  assert.equal(readCachedComparisons('user-a', broken), null);
});
