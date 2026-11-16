import assert from 'node:assert/strict';
import test from 'node:test';
import { unarchiveUndo } from '../../services/undoRules.ts';
import type { StoredItem } from '../../types.ts';

// services/undoRules.ts: what the undo pill takes back, and when its shortcut acts.

const card = (fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab',
  data: { id: 'w1', word: 'gamut', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id: 'w1', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
  ...fields,
});

test('undoing an unarchive archives the card again as it was, unless it was archived again meanwhile', () => {
  const before = card({ isArchived: true, updatedAt: 10 });
  const undo = unarchiveUndo(before);
  assert.deepEqual(undo(card({ isArchived: undefined, updatedAt: 20 })), card({ isArchived: true, updatedAt: 10 }));
  const archivedAgain = card({ isArchived: true, updatedAt: 30 });
  assert.equal(undo(archivedAgain), archivedAgain);
});
