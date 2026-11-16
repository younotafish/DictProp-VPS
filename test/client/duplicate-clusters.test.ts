import assert from 'node:assert/strict';
import test from 'node:test';
import { findDuplicateClusterViews } from '../../services/duplicateClusters.ts';
import type { StoredItem } from '../../types.ts';

const card = (word: string, forms?: string[], id = word): StoredItem => ({
  type: 'vocab',
  data: { id, word, forms, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
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

test('one pass lists each cluster’s cards in library order and counts them by the normalized base word', () => {
  const items = [
    card('don’t', undefined, 'curly'),
    card('see', ['sees', 'saw']),
    card('apple'),
    card('do', ['does', 'did', "don't"]),
    card("don't", undefined, 'straight'),
    card('saw', ['saws', 'sawed']),
    { ...card('phrase'), type: 'phrase' } as StoredItem,
  ];
  const clusters = findDuplicateClusterViews(items);
  assert.deepEqual(clusters.map(cluster => cluster.baseWords), [['do', "don't"], ['saw', 'see']]);
  assert.deepEqual(clusters.map(cluster => cluster.id), ['dup-0', 'dup-1']);
  const [doCluster, seeCluster] = clusters;
  assert.deepEqual(doCluster.items.map(item => item.data.id), ['curly', 'do', 'straight']);
  assert.deepEqual(doCluster.counts, { do: 1, "don't": 2 }, 'the curly apostrophe counts under the straight one');
  assert.deepEqual(seeCluster.items.map(item => item.data.id), ['see', 'saw']);
  assert.deepEqual(seeCluster.counts, { saw: 1, see: 1 });
});

test('a base word called like an Object property counts from zero', () => {
  const [cluster] = findDuplicateClusterViews([card('constructor', ['constructors']), card('constructors')]);
  assert.deepEqual(cluster.counts, { constructor: 1, constructors: 1 });
});
