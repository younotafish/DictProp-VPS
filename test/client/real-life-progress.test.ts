import assert from 'node:assert/strict';
import test from 'node:test';
import { REAL_LIFE_COLLECTIONS } from '../../services/realLifeCatalog.ts';
import {
  buildRealLifeStudyItems,
  createRealLifeProgressItem,
  createRealLifeProgressItemFromId,
  getRealLifeCollectionProgress,
  isRealLifeProgressItem,
  realLifeProgressItemId,
} from '../../services/realLifeProgress.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';

const NOW = 2_000_000;

test('Real Life progress ids are stable and include the collection boundary', () => {
  const career = REAL_LIFE_COLLECTIONS[0].sentences[0];
  const item = createRealLifeProgressItem(career, 100);

  assert.equal(item.data.id, realLifeProgressItemId(career.id));
  assert.equal((item.data as any).catalogCollectionId, 'career-conversations');
  assert.equal((item.data as any).catalogSentenceId, career.id);
  assert.equal(isRealLifeProgressItem(item), true);
  const recreated = createRealLifeProgressItemFromId(item.data.id, 100);
  assert.ok(recreated);
  assert.deepEqual(recreated.data, item.data);
  assert.equal(recreated.savedAt, item.savedAt);
  assert.equal(recreated.srs.id, item.srs.id);
  assert.equal(recreated.srs.type, item.srs.type);
  assert.equal(recreated.srs.totalReviews, 0);
  assert.equal(createRealLifeProgressItemFromId('real-life-sentence:not-in-catalog'), null);
});

test('each collection computes an isolated queue and mastery score', () => {
  const career = REAL_LIFE_COLLECTIONS[0];
  const careerItem = createRealLifeProgressItem(career.sentences[0], 100);
  careerItem.srs = {
    ...SRSAlgorithm.createNew(careerItem.data.id, 'sentence'),
    totalReviews: 3,
    memoryStrength: 60,
    nextReview: NOW - 1,
  };

  const careerProgress = getRealLifeCollectionProgress(career, [careerItem], NOW);
  assert.deepEqual(
    { reviewed: careerProgress.reviewed, due: careerProgress.due, memorized: careerProgress.memorized },
    { reviewed: 1, due: 1, memorized: 0 },
  );
  assert.equal(careerProgress.unreviewed, career.sentences.length - 1);
  assert.equal(careerProgress.masteryScore, Math.round(60 / career.sentences.length));

  for (const collection of REAL_LIFE_COLLECTIONS.slice(1)) {
    const isolatedProgress = getRealLifeCollectionProgress(collection, [careerItem], NOW);
    assert.equal(isolatedProgress.reviewed, 0, `${collection.id} must not inherit Career reviews`);
    assert.equal(isolatedProgress.due, 0, `${collection.id} must not inherit Career due cards`);
    assert.equal(isolatedProgress.masteryScore, 0, `${collection.id} must not inherit Career mastery`);
    assert.equal(isolatedProgress.unreviewed, collection.sentences.length);
  }
});

test('study items overlay only their exact stored catalog progress', () => {
  const career = REAL_LIFE_COLLECTIONS[0];
  const stored = createRealLifeProgressItem(career.sentences[1], 100);
  stored.srs = { ...stored.srs, totalReviews: 2, memoryStrength: 35 };

  const queue = buildRealLifeStudyItems(career.sentences.slice(0, 3), [stored], 500);
  assert.equal(queue.length, 3);
  assert.equal(queue[0].srs.totalReviews, 0);
  assert.equal(queue[1], stored);
  assert.equal(queue[2].srs.totalReviews, 0);
  assert.ok(queue.every(item => (item.data as any).catalogCollectionId === career.id));
});
