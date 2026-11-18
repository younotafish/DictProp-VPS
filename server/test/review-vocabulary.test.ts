import assert from 'node:assert/strict';
import test from 'node:test';
import { isReviewRating, isReviewTaskType, REVIEW_RATINGS, REVIEW_TASK_TYPES } from '../src/shared/review.js';

test('review ratings and task types are closed sets', () => {
  assert.deepEqual(REVIEW_RATINGS, ['again', 'hard', 'good', 'easy']);
  assert.deepEqual(REVIEW_TASK_TYPES, ['meaning', 'production', 'cloze', 'listening', 'quick', 'triage', 'speak', 'recall']);
  for (const rating of REVIEW_RATINGS) assert.equal(isReviewRating(rating), true);
  for (const task of REVIEW_TASK_TYPES) assert.equal(isReviewTaskType(task), true);
  for (const value of ['Good', 'perfect', '', null, undefined, 1, ['good']]) {
    assert.equal(isReviewRating(value), false, String(value));
    assert.equal(isReviewTaskType(value), false, String(value));
  }
});
