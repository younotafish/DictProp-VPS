import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizedSrs, SRS_COUNTERS } from '../src/scripts/support/stored-item.js';
import { REQUIRED_SRS_FIELDS, validateStoredItem } from '../src/validation.js';

const stored = (srs: Record<string, unknown>) => ({ type: 'vocab', data: { id: 'word', word: 'word' }, srs, savedAt: 1 });

test('the scripts repair exactly the SRS counters validation requires', () => {
  assert.equal(SRS_COUNTERS, REQUIRED_SRS_FIELDS);
  const repaired = normalizedSrs({ type: 'vocab', data: { id: 'word' } }, { nextReview: -1, interval: 'soon' });
  assert.equal(validateStoredItem(stored(repaired)), null);
  for (const field of REQUIRED_SRS_FIELDS) {
    const { [field]: _missing, ...withoutField } = repaired;
    assert.equal(validateStoredItem(stored(withoutField)), `item.srs.${field} is invalid`, field);
    assert.equal(validateStoredItem(stored({ ...repaired, [field]: -1 })), `item.srs.${field} is invalid`, field);
  }
});
