import assert from 'node:assert/strict';
import test from 'node:test';
import { findDuplicateClusterViews } from '../../services/duplicateClusters.ts';
import type { StoredItem } from '../../types.ts';

const card = (word: string, forms?: string[]): StoredItem => ({
  type: 'vocab',
  data: { id: word, word, forms, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id: word, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});

test('variant spellings of one word form a cluster that suggests the shortest spelling', () => {
  const items = [card('running'), card('run'), card('apple')];
  const clusters = findDuplicateClusterViews(items);
  assert.equal(clusters.length, 1);
  const [cluster] = clusters;
  assert.equal(cluster.id, 'dup-0');
  assert.equal(cluster.suggestedCanonical, 'run');
  assert.deepEqual([...cluster.baseWords].sort(), ['run', 'running']);
  assert.deepEqual(cluster.items.map(item => item.data.id).sort(), ['run', 'running']);
});

test('a notebook without variants has no clusters', () => {
  assert.deepEqual(findDuplicateClusterViews([card('apple'), card('pear')]), []);
  assert.deepEqual(findDuplicateClusterViews([]), []);
});
