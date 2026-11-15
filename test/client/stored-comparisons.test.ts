import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeComparisons, readCachedComparisons, writeCachedComparisons } from '../../components/search/storedComparisons.ts';
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

test('the server list comes first, each entry replaced by a newer copy from this device', () => {
  const server = [comparison('fable|parable', 10), comparison('decay|rot', 20), comparison('a|b', 30)];
  const local = [comparison('decay|rot', 25), comparison('a|b', 30), comparison('fable|parable', 5)];
  const { merged, toUpload } = mergeComparisons(local, server);
  assert.deepEqual(merged, [comparison('fable|parable', 10), comparison('decay|rot', 25), comparison('a|b', 30)]);
  // An equal or older local copy stays as the server has it and isn't sent again.
  assert.deepEqual(toUpload, [comparison('decay|rot', 25)]);
});

test('comparisons only this device has are kept, after the server list, and listed for upload', () => {
  const server = [comparison('fable|parable', 10)];
  const local = [comparison('x|y', 40), comparison('fable|parable', 10), comparison('p|q', 41)];
  const { merged, toUpload } = mergeComparisons(local, server);
  assert.deepEqual(merged, [comparison('fable|parable', 10), comparison('x|y', 40), comparison('p|q', 41)]);
  assert.deepEqual(toUpload, [comparison('x|y', 40), comparison('p|q', 41)]);
});

test('with nothing on the device the server list is taken as it is', () => {
  const server = [comparison('fable|parable', 10), comparison('decay|rot', 20)];
  const { merged, toUpload } = mergeComparisons([], server);
  assert.deepEqual(merged, server);
  assert.deepEqual(toUpload, []);
});

test('a malformed local entry is dropped rather than kept or sent', () => {
  const malformed = [
    null,
    { key: '', words: ['a'], data: {}, updatedAt: 1 },
    { key: 'a|b', words: 'a b', data: {}, updatedAt: 1 },
    { key: 'a|b', words: ['a', 2], data: {}, updatedAt: 1 },
    { key: 'a|b', words: ['a', 'b'], data: null, updatedAt: 1 },
    { key: 'a|b', words: ['a', 'b'], data: {}, updatedAt: Number.NaN },
  ] as unknown as StoredComparison[];
  assert.deepEqual(mergeComparisons(malformed, []), { merged: [], toUpload: [] });
});
