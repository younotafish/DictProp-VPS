import assert from 'node:assert/strict';
import test from 'node:test';
import { Lru, UrlLru, setUrlInUse } from '../../services/audio/urlLru.ts';

const revoked: string[] = [];
const realRevoke = URL.revokeObjectURL;
URL.revokeObjectURL = (url: string) => { revoked.push(url); };
test.after(() => { URL.revokeObjectURL = realRevoke; });
test.beforeEach(() => {
  revoked.length = 0;
  setUrlInUse(null);
});

test('the least recently used entry goes first, and a read counts as a use', () => {
  const evicted: number[] = [];
  const lru = new Lru<number>(2, value => evicted.push(value));
  lru.set('a', 1);
  lru.set('b', 2);
  assert.equal(lru.get('a'), 1);
  lru.set('c', 3);
  assert.deepEqual(evicted, [2], 'b was used longest ago');
  assert.equal(lru.get('b'), undefined);
  assert.equal(lru.size, 2);
  lru.set('a', 1);
  lru.set('d', 4);
  assert.deepEqual(evicted, [2, 3], 'rewriting a marks it used');
});

test('replacing an entry releases the value it replaced', () => {
  const evicted: number[] = [];
  const lru = new Lru<number>(5, value => evicted.push(value));
  lru.set('a', 1);
  lru.set('a', 1);
  assert.deepEqual(evicted, [], 'the same value is kept');
  lru.set('a', 2);
  assert.deepEqual(evicted, [1]);
});

test('an evicted object URL is revoked', () => {
  const urls = new UrlLru(1);
  urls.set('a', 'blob:a');
  urls.set('b', 'blob:b');
  assert.deepEqual(revoked, ['blob:a']);
});

test('the URL the <audio> element is using is revoked only once it moves on', () => {
  const urls = new UrlLru(1);
  urls.set('a', 'blob:a');
  setUrlInUse('blob:a');
  urls.set('b', 'blob:b');
  assert.deepEqual(revoked, [], 'the playing clip keeps its URL');
  assert.equal(urls.get('a'), undefined, 'but leaves the cache');
  setUrlInUse('blob:a');
  assert.deepEqual(revoked, [], 'the same source keeps it');
  setUrlInUse('data:audio/wav;base64,');
  assert.deepEqual(revoked, ['blob:a']);
  setUrlInUse('blob:b');
  assert.deepEqual(revoked, ['blob:a'], 'nothing is revoked twice');
});
