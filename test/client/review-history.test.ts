import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent, ReviewHistory } from '../../types.ts';
import { RECENT_DAYS, mergeLoadedHistory, recentSinceFor } from '../../services/reviewHistory.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 16, 15, 30);

const review = (id: string, reviewedAt: number, rating: ReviewEvent['rating'] = 'good'): ReviewEvent =>
  ({ id, itemId: `item-${id}`, itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 1, rating });
const history = (recent: ReviewEvent[], olderTimes: number[] = [], olderCount = olderTimes.length): ReviewHistory =>
  ({ recent, olderTimes, olderCount });

test('a load takes reviews in full from a week and a day back, or from the oldest review still in the outbox', () => {
  assert.equal(RECENT_DAYS, 8);
  assert.equal(recentSinceFor([], NOW), NOW - 8 * DAY);
  assert.equal(recentSinceFor([review('a', NOW - HOUR)], NOW), NOW - 8 * DAY, 'a recent outbox review changes nothing');
  assert.equal(recentSinceFor([review('a', NOW - HOUR), review('b', NOW - 10 * DAY), review('c', NOW - 9 * DAY)], NOW), NOW - 10 * DAY);
});

test('a loaded history keeps the reviews this device already holds, oldest first, its own copy of each winning', () => {
  const remote = history([review('a', NOW - 3 * DAY), review('b', NOW - DAY, 'again')], [NOW - 30 * DAY], 12);
  const current = history([review('b', NOW - DAY, 'hard'), review('c', NOW - 2 * DAY)]);
  const merged = mergeLoadedHistory(current, remote);
  assert.deepEqual(merged.recent.map(event => [event.id, event.rating]), [['a', 'good'], ['c', 'good'], ['b', 'hard']]);
  assert.deepEqual(merged.olderTimes, [NOW - 30 * DAY]);
  assert.equal(merged.olderCount, 12);
});
