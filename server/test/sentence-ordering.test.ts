import assert from 'node:assert/strict';
import test from 'node:test';
import { orderSentencesForReview } from '../../services/sentenceOrdering.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { StoredItem } from '../../types.ts';

const NOW = 10_000;

function sentence(
  id: string,
  memoryStrength: number,
  savedAt: number,
  totalReviews: number,
  nextReview: number,
): StoredItem {
  return {
    type: 'sentence',
    savedAt,
    data: { id, text: id, sourceWord: '' },
    srs: {
      ...SRSAlgorithm.createNew(id, 'sentence'),
      memoryStrength,
      totalReviews,
      nextReview,
    },
  };
}

test('every sentence category is ordered by weakest memory, then newest addition', () => {
  const items = [
    sentence('newer-unreviewed', 0, 400, 0, 0),
    sentence('older-unreviewed', 0, 100, 0, 0),
    sentence('weak-due', 12, 200, 2, NOW - 1),
    sentence('strong-due', 35, 500, 3, NOW - 1),
    sentence('newer-memorized', 70, 600, 4, NOW + 1),
    sentence('older-memorized', 70, 300, 4, NOW + 1),
  ];

  assert.deepEqual(
    orderSentencesForReview(items, 'all', NOW).map(item => item.data.id),
    ['newer-unreviewed', 'older-unreviewed', 'weak-due', 'strong-due', 'newer-memorized', 'older-memorized'],
  );
  assert.deepEqual(
    orderSentencesForReview(items, 'unreviewed', NOW).map(item => item.data.id),
    ['newer-unreviewed', 'older-unreviewed'],
  );
  assert.deepEqual(
    orderSentencesForReview(items, 'due', NOW).map(item => item.data.id),
    ['weak-due', 'strong-due'],
  );
  assert.deepEqual(
    orderSentencesForReview(items, 'memorized', NOW).map(item => item.data.id),
    ['newer-memorized', 'older-memorized'],
  );
});
