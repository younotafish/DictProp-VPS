import assert from 'node:assert/strict';
import test from 'node:test';
import { updateAfterRating } from '../../services/fsrsScheduler.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { formatDueLabel } from '../../views/reading/dueLabel.ts';

// Local times, so the expectations hold in any time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const MONDAY = 16;

test('a time that has come is due', () => {
  assert.equal(formatDueLabel(at(MONDAY, 9), at(MONDAY, 9)), 'due');
  assert.equal(formatDueLabel(at(MONDAY, 8), at(MONDAY, 9)), 'due');
});

test('the label counts calendar days, not 24-hour periods', () => {
  assert.equal(formatDueLabel(at(MONDAY, 21), at(MONDAY, 9)), 'today');
  assert.equal(formatDueLabel(at(MONDAY + 1, 8), at(MONDAY, 9)), 'tomorrow');
  assert.equal(formatDueLabel(at(MONDAY + 1, 0, 30), at(MONDAY, 23, 30)), 'tomorrow');
  assert.equal(formatDueLabel(at(MONDAY + 2, 9), at(MONDAY, 9)), 'in 2d');
  assert.equal(formatDueLabel(at(MONDAY + 11, 9), at(MONDAY, 9)), 'in 11d');
});

test('the first Reviewed tap on a new sentence reads two days ahead', () => {
  const reviewedAt = at(MONDAY, 9);
  const srs = updateAfterRating(SRSAlgorithm.createNew('sentence-1', 'sentence'), 'good', reviewedAt);
  assert.equal(formatDueLabel(srs.nextReview, reviewedAt + 5), 'in 2d');
});

test('a daylight-saving change in between still counts calendar days', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // New York springs forward on 2026-03-08 and falls back on 2026-11-01.
    assert.equal(formatDueLabel(new Date(2026, 2, 9, 9).getTime(), new Date(2026, 2, 7, 9).getTime()), 'in 2d');
    assert.equal(formatDueLabel(new Date(2026, 2, 8, 23).getTime(), new Date(2026, 2, 7, 23).getTime()), 'tomorrow');
    assert.equal(formatDueLabel(new Date(2026, 10, 2, 9).getTime(), new Date(2026, 9, 31, 9).getTime()), 'in 2d');
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
