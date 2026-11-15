import assert from 'node:assert/strict';
import test from 'node:test';
import { swipeDirection } from '../../views/notebook/useHorizontalSwipe.ts';

test('a swipe is more than 50 px sideways and half again as far sideways as up or down', () => {
  assert.equal(swipeDirection(-60, 0), 'left');
  assert.equal(swipeDirection(60, 10), 'right');
  assert.equal(swipeDirection(-90, 59), 'left');
  // Too short, or too steep: a tap or a scroll.
  assert.equal(swipeDirection(50, 0), null);
  assert.equal(swipeDirection(-49, 0), null);
  assert.equal(swipeDirection(90, 60), null);
  assert.equal(swipeDirection(0, 200), null);
  assert.equal(swipeDirection(0, 0), null);
});
