import assert from 'node:assert/strict';
import test from 'node:test';
import { swipeDirection } from '../../components/swipeDirection.ts';
import { touchFacts } from '../../views/detail/touchGestures.ts';

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

test('the review popup and the card view ask for 60 px, with the same slope', () => {
  assert.equal(swipeDirection(55, 0, 60), null);
  assert.equal(swipeDirection(-60, 0, 60), null);
  assert.equal(swipeDirection(61, 0, 60), 'right');
  assert.equal(swipeDirection(-61, 40, 60), 'left');
  assert.equal(swipeDirection(-90, 60, 60), null);
  // The card view's touches classify by the same rule.
  for (const [dx, dy] of [[55, 0], [61, 0], [-61, 40], [-90, 60], [-200, 133], [-200, 134]]) {
    assert.equal(touchFacts(dx, dy, null).isHorizontalSwipe, swipeDirection(dx, dy, 60) !== null, `${dx}, ${dy}`);
  }
});
