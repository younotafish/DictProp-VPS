import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isFiniteNonNegative, isItemType, isPositiveFinite, isRecord, isSha256, SAFE_IMAGE_PATH,
} from '../src/validation-helpers.js';

test('the shared validator predicates', () => {
  assert.deepEqual(['vocab', 'phrase', 'sentence', 'Vocab', 'comparison', undefined].map(isItemType), [true, true, true, false, false, false]);
  assert.deepEqual([{}, { a: 1 }, [], null, 'x', 1].map(isRecord), [true, true, false, false, false, false]);
  assert.equal(isSha256('a'.repeat(64)), true);
  for (const value of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 1]) assert.equal(isSha256(value), false, String(value));
  assert.deepEqual([0, 1.5, -1, Infinity, NaN, '1'].map(isFiniteNonNegative), [true, true, false, false, false, false]);
  assert.deepEqual([0, 1.5, -1, Infinity, NaN, '1'].map(isPositiveFinite), [false, true, false, false, false, false]);
  for (const path of ['images/a.png', 'images/a-b_c.1.JPEG', 'images/x.webp']) assert.match(path, SAFE_IMAGE_PATH);
  for (const path of ['images/../a.png', 'a.png', 'images/a.svg', 'images/sub/a.png']) assert.doesNotMatch(path, SAFE_IMAGE_PATH);
});
