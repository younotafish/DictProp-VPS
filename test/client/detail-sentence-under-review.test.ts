import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSentenceUnderReview } from '../../views/detail/sentenceUnderReview.ts';
import type { SentenceData, StoredItem } from '../../types.ts';

const srs = (id: string, totalReviews = 0) => ({
  id, type: 'sentence' as const, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews, correctStreak: 0, stability: 0,
});
const sentence = (id: string, text: string, extra: Partial<SentenceData> = {}, totalReviews = 0): StoredItem => ({
  type: 'sentence', data: { id, text, sourceWord: 'word', ...extra }, srs: srs(id, totalReviews), savedAt: 1,
});
const noText = () => undefined;

test('an ordinary saved sentence is shown as listed and reviews under its own id', () => {
  const saved = sentence('s1', 'A saved sentence.');
  const result = resolveSentenceUnderReview(saved, undefined, [saved], noText, false);
  assert.equal(result.currentSentence, saved);
  assert.equal(result.isSentencePreview, false);
  assert.equal(result.catalogSentencePreview, false);
  assert.equal(result.sentenceExitLabel, 'Sentences');
});

test('an unsaved example preview is read-only until a saved sentence with its text appears', () => {
  const preview = sentence('sentence-preview:1', 'An example.');
  const unsaved = resolveSentenceUnderReview(preview, undefined, [], noText, false);
  assert.equal(unsaved.isSentencePreview, true);
  assert.equal(unsaved.readOnlySentencePreview, false);
  assert.equal(unsaved.sentenceExitLabel, 'Word');

  const saved = sentence('s9', 'An example.', {}, 3);
  const bound = resolveSentenceUnderReview(preview, undefined, [saved], text => text === 'An example.' ? saved : undefined, false);
  assert.equal(bound.isSentencePreview, false);
  assert.equal(bound.currentSentence?.data.id, 's9');
  assert.equal(bound.currentSentence?.srs.totalReviews, 3);
  assert.equal(bound.sentenceExitLabel, 'Sentences');
});

test('a sentence the caller marks preview-only stays read-only unless it binds to a saved copy', () => {
  const listed = sentence('s1', 'Listed.');
  const result = resolveSentenceUnderReview(listed, undefined, [listed], () => listed, true);
  assert.equal(result.readOnlySentencePreview, true);
  assert.equal(result.isSentencePreview, true, 'only preview ids look for a saved copy by text');
  assert.equal(result.sentenceExitLabel, 'Word');
});

test('a catalog sentence binds to its progress record by id, or by catalog sentence and collection', () => {
  const listed = sentence('real-life:c1:s9', 'Catalog.', { catalogKind: 'real-life', catalogSentenceId: 's9', catalogCollectionId: 'c1' });
  const unsaved = resolveSentenceUnderReview(listed, undefined, [], noText, false);
  assert.equal(unsaved.catalogSentencePreview, true);
  assert.equal(unsaved.readOnlySentencePreview, true);
  assert.equal(unsaved.isSentencePreview, true);
  assert.equal(unsaved.sentenceExitLabel, 'Real Life');

  const record = sentence('older-record', 'Catalog.', { catalogSentenceId: 's9', catalogCollectionId: 'c1' }, 2);
  const otherCollection = sentence('other', 'Catalog.', { catalogSentenceId: 's9', catalogCollectionId: 'c2' }, 5);
  const deleted = { ...sentence('real-life:c1:s9', 'Catalog.'), isDeleted: true };
  const bound = resolveSentenceUnderReview(listed, undefined, [deleted, otherCollection, record], noText, false);
  assert.equal(bound.isSentencePreview, false);
  assert.equal(bound.readOnlySentencePreview, false);
  assert.equal(bound.currentSentence?.data.id, 'older-record');
  assert.equal(bound.sentenceExitLabel, 'Real Life');
});

test('an essay sentence returns to Essays', () => {
  const listed = sentence('essay:e1:s2', 'Essay.', { catalogKind: 'essay', catalogSentenceId: 's2', catalogCollectionId: 'e1' });
  assert.equal(resolveSentenceUnderReview(listed, undefined, [], noText, false).sentenceExitLabel, 'Essays');
});

test('a prepared analysis and image fill in what the live copy lacks, under the live data', () => {
  const live = sentence('s1', 'Live.', { imageUrl: 'idb:stored' }, 4);
  const prepared = sentence('s1', 'Live.', { imageUrl: 'data:image/png;base64,AA', analysisGeneratedAt: 7 });
  const result = resolveSentenceUnderReview(live, prepared, [live], noText, false);
  assert.equal((result.currentSentence?.data as SentenceData).imageUrl, 'idb:stored');
  assert.equal((result.currentSentence?.data as SentenceData).analysisGeneratedAt, 7);
  assert.equal(result.currentSentence?.srs.totalReviews, 4);
});

test('with nothing listed there is no sentence', () => {
  const result = resolveSentenceUnderReview(null, undefined, [], noText, false);
  assert.equal(result.currentSentence, null);
  assert.equal(result.isSentencePreview, false);
  assert.equal(result.catalogPreviewKind, undefined);
});
