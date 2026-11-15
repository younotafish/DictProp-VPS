import assert from 'node:assert/strict';
import test from 'node:test';
import { isItemId, MAX_ID_LENGTH, parseReviewEvent } from '../src/validation.js';

const event = { id: 'event-1', itemId: 'item-1', itemType: 'vocab', reviewedAt: 1_000, previousStep: 0, nextStep: 1 };

test('an item id is a non-empty string of at most 200 characters', () => {
  assert.equal(MAX_ID_LENGTH, 200);
  assert.equal(isItemId('a'), true);
  assert.equal(isItemId('a'.repeat(200)), true);
  for (const invalid of ['', 'a'.repeat(201), 7, null, undefined, {}]) assert.equal(isItemId(invalid), false);
});

test('a review event keeps its known fields and drops anything else', () => {
  assert.deepEqual(parseReviewEvent(event), event);
  const full = { ...event, rating: 'hard', taskType: 'cloze', durationMs: 0, sessionId: '', extra: 'ignored' };
  const { extra: _extra, ...expected } = full;
  assert.deepEqual(parseReviewEvent(full), expected);
});

test('a review event with any field out of bounds is refused', () => {
  for (const invalid of [
    null, [], 'event',
    { ...event, id: '' }, { ...event, id: 'a'.repeat(201) }, { ...event, itemId: 7 },
    { ...event, itemType: 'project' },
    { ...event, reviewedAt: -1 }, { ...event, reviewedAt: '1000' }, { ...event, reviewedAt: Infinity },
    { ...event, previousStep: 0.5 }, { ...event, previousStep: -1 }, { ...event, nextStep: '1' },
    { ...event, rating: 'perfect' }, { ...event, rating: null }, { ...event, taskType: 'essay' },
    { ...event, durationMs: -1 }, { ...event, durationMs: 86_400_001 }, { ...event, durationMs: 1.5 },
    { ...event, sessionId: 'a'.repeat(201) }, { ...event, sessionId: 5 },
  ]) {
    assert.equal(parseReviewEvent(invalid), null, JSON.stringify(invalid));
  }
});
