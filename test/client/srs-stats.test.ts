import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimeUntil } from '../../services/studySession.ts';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('the next review reads in whole days, hours or minutes, and as now once it is due', () => {
  assert.equal(formatTimeUntil(NOW - 1, NOW), 'now');
  assert.equal(formatTimeUntil(NOW, NOW), 'now');
  assert.equal(formatTimeUntil(NOW + MINUTE - 1, NOW), 'now');
  assert.equal(formatTimeUntil(NOW + MINUTE, NOW), '1m');
  assert.equal(formatTimeUntil(NOW + HOUR - 1, NOW), '59m');
  assert.equal(formatTimeUntil(NOW + HOUR, NOW), '1h');
  assert.equal(formatTimeUntil(NOW + DAY - 1, NOW), '23h');
  assert.equal(formatTimeUntil(NOW + 3 * DAY + 5 * HOUR, NOW), '3d');
});
