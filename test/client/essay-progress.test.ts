import assert from 'node:assert/strict';
import test from 'node:test';
import { ESSAYS } from '../../services/essayCatalog.ts';
import { summarizeCatalogProgress } from '../../services/catalogProgress.ts';
import {
  buildEssayStudyItems,
  createEssayProgressItem,
  indexEssayProgress,
} from '../../services/essayProgress.ts';
import { essayProgressItemId, isEssayProgressItem } from '../../services/essayProgressIdentity.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceData } from '../../types.ts';

const NOW = 2_000_000;

test('Essay progress ids and provenance remain stable', () => {
  const sentence = ESSAYS[0].sentences[0];
  const item = createEssayProgressItem(sentence, 100);
  const data = item.data as SentenceData;

  assert.equal(item.data.id, essayProgressItemId(sentence.id));
  assert.equal(data.catalogKind, 'essay');
  assert.equal(data.catalogCollectionId, 'self-reliance');
  assert.equal(data.catalogSentenceId, sentence.id);
  assert.equal(isEssayProgressItem(item), true);
});

test('each essay computes an isolated memorization score', () => {
  const firstEssay = ESSAYS[0];
  const item = createEssayProgressItem(firstEssay.sentences[0], 100);
  item.srs = {
    ...SRSAlgorithm.createNew(item.data.id, 'sentence'),
    totalReviews: 3,
    memoryStrength: 60,
    nextReview: NOW - 1,
  };

  const index = indexEssayProgress([item]);
  const progress = summarizeCatalogProgress(firstEssay.sentences, index, NOW);
  assert.equal(progress.reviewed, 1);
  assert.equal(progress.due, 1);
  assert.equal(progress.masteryScore, Math.round(60 / firstEssay.sentences.length));

  for (const essay of ESSAYS.slice(1)) {
    const isolated = summarizeCatalogProgress(essay.sentences, index, NOW);
    assert.equal(isolated.reviewed, 0, `${essay.id} must not inherit another essay's reviews`);
    assert.equal(isolated.masteryScore, 0);
  }
});

test('study queues overlay only exact essay sentence progress', () => {
  const essay = ESSAYS[1];
  const stored = createEssayProgressItem(essay.sentences[1], 100);
  stored.srs = { ...stored.srs, totalReviews: 2, memoryStrength: 35 };

  const queue = buildEssayStudyItems(essay.sentences.slice(0, 3), indexEssayProgress([stored]), 500);
  assert.equal(queue.length, 3);
  assert.equal(queue[0].srs.totalReviews, 0);
  assert.equal(queue[1], stored);
  assert.equal(queue[2].srs.totalReviews, 0);
  assert.equal(queue[0].savedAt, 500);
  assert.ok(queue.every(item => (item.data as SentenceData).catalogCollectionId === essay.id));
});
