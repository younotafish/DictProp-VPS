import assert from 'node:assert/strict';
import test from 'node:test';
import { USAGE_PRIORITY, USAGE_STATUSES } from '../src/shared/usage-audit.js';

test('every usage status has its own rank, the most useful American usage first', () => {
  assert.deepEqual(Object.keys(USAGE_PRIORITY).sort(), [...USAGE_STATUSES].sort());
  assert.deepEqual(
    Object.entries(USAGE_PRIORITY).sort(([, a], [, b]) => a - b).map(([status]) => status),
    ['modern_american', 'current_general', 'narrow_specialized', 'british_only', 'rare_or_dated'],
  );
  assert.deepEqual(Object.values(USAGE_PRIORITY).sort(), [0, 1, 2, 3, 4]);
});
