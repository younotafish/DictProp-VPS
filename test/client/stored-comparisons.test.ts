import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeComparisons, readCachedComparisons, writeCachedComparisons } from '../../components/search/storedComparisons.ts';
import { sanitizeStoredComparisons } from '../../services/api/comparisons.ts';
import { defaultSessionStorage, defaultStorage } from '../../services/browserStorage.ts';
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
  storage.setItem('vps_comparisons_cache_user-a', '[]');
  assert.deepEqual(readCachedComparisons('user-a', storage), [], 'while an empty list is a list');
});

test('a malformed entry an older build cached reads back cleaned, as the server list does', () => {
  const storage = new MemoryStorage();
  const cached = [
    null,
    'fable|parable',
    {
      key: 'affect|effect',
      words: ['affect', 3, 'effect'],
      data: {
        words: ['affect', null],
        summary: 7,
        dimensions: [{ label: 'Register', perWord: { affect: ['neutral'], effect: 'formal' } }, { analysis: 'no label' }],
        examples: 'none',
        commonMistakes: [{ wrong: true }],
        verdict: 'Affect is the verb.',
      },
      updatedAt: 5,
    },
    comparison('decay|rot', 2),
  ];
  storage.setItem('vps_comparisons_cache_user-a', JSON.stringify(cached));
  const read = readCachedComparisons('user-a', storage);
  assert.deepEqual(read, [
    {
      key: 'affect|effect',
      words: ['affect', 'effect'],
      data: {
        words: ['affect', 'effect'],
        summary: '',
        dimensions: [{ label: 'Register', analysis: '', perWord: { effect: 'formal' } }],
        examples: [],
        commonMistakes: [],
        verdict: 'Affect is the verb.',
      },
      updatedAt: 5,
    },
    comparison('decay|rot', 2),
  ]);
  assert.deepEqual(read, sanitizeStoredComparisons(cached));
});

test('storage that refuses a write or a read is ignored', () => {
  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.doesNotThrow(() => writeCachedComparisons('user-a', [comparison('a|b', 1)], broken));
  assert.equal(readCachedComparisons('user-a', broken), null);
});

/** Runs `body` with the global `name` defined by `descriptor`, then puts back what was there. */
function withGlobal(name: 'localStorage' | 'sessionStorage', descriptor: PropertyDescriptor, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
  try {
    body();
  } finally {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  }
}
// What a browser that blocks storage (Safari with all cookies blocked, a sandboxed frame) does when the page touches it.
const refused: PropertyDescriptor = { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } };

test('with the browser refusing its storage, the cache reads as nothing and writes nowhere', () => {
  withGlobal('localStorage', refused, () => {
    assert.equal(readCachedComparisons('user-a'), null);
    assert.doesNotThrow(() => writeCachedComparisons('user-a', [comparison('a|b', 1)]));
  });
});

// browserStorage's getters: the search retry takes sessionStorage from there, the review outbox localStorage.
test("the device storage getters hand out the browser's storage, or none where it is missing or refused", () => {
  const storage = new MemoryStorage();
  withGlobal('sessionStorage', { value: storage }, () => assert.equal(defaultSessionStorage(), storage));
  withGlobal('sessionStorage', { value: undefined }, () => assert.equal(defaultSessionStorage(), null));
  withGlobal('sessionStorage', refused, () => assert.equal(defaultSessionStorage(), null));
  withGlobal('localStorage', { value: storage }, () => assert.equal(defaultStorage(), storage));
  withGlobal('localStorage', { value: undefined }, () => assert.equal(defaultStorage(), null));
  withGlobal('localStorage', refused, () => assert.equal(defaultStorage(), null));
});

test('the server list comes first, each entry replaced by a newer copy from this device', () => {
  const server = [comparison('fable|parable', 10), comparison('decay|rot', 20), comparison('a|b', 30)];
  const local = [comparison('decay|rot', 25), comparison('a|b', 30), comparison('fable|parable', 5)];
  const { merged, toUpload } = mergeComparisons(local, server);
  assert.deepEqual(merged, [comparison('fable|parable', 10), comparison('decay|rot', 25), comparison('a|b', 30)]);
  // A word set the server holds isn't sent again, whichever copy is newer.
  assert.deepEqual(toUpload, []);
});

test('a copy stamped by a fast clock never replaces the server copy another device saved later', () => {
  const minute = 60_000;
  // The phone, an hour fast, made 'fable vs parable' at T and stamped it T+60m; the server capped it at T+5m. The
  // laptop made it again at T+20m, and the server took that copy. At T+30m the phone loads.
  const fromPhone = comparison('fable|parable', 60 * minute);
  const fromLaptop = { ...comparison('fable|parable', 20 * minute), data: { ...fromPhone.data, verdict: 'laptop' } };
  const { merged, toUpload } = mergeComparisons([fromPhone], [fromLaptop]);
  assert.deepEqual(merged, [fromPhone], 'the phone still shows its own copy');
  assert.deepEqual(toUpload, [], "and doesn't send it, which would replace the laptop's later copy");
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
