import assert from 'node:assert/strict';
import test from 'node:test';
import { indexSavedSentences } from '../../views/detail/useSavedSentenceIndex.ts';
import { resolveSentenceUnderReview } from '../../views/detail/sentenceUnderReview.ts';
import { normalizeSentenceIdentity } from '../../services/sentenceIdentity.ts';
import type { SentenceData, StoredItem } from '../../types.ts';

const srs = (id: string) => ({
  id, type: 'sentence' as const, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 3, correctStreak: 0, stability: 0,
});
const sentence = (id: string, text: string, extra: Partial<SentenceData> = {}, isDeleted = false): StoredItem => ({
  type: 'sentence', data: { id, text, sourceWord: 'word', ...extra }, srs: srs(id), savedAt: 1, ...(isDeleted ? { isDeleted } : {}),
});
const TEXT = 'The meeting ran long.';
const ordinary = sentence('s1', TEXT);
const realLife = sentence('real-life-sentence:rl-7', 'the meeting ran long', { catalogSentenceId: 'rl-7', catalogCollectionId: 'office' });
const essay = sentence('essay-sentence:es-3', TEXT, { catalogKind: 'essay', catalogSentenceId: 'es-3', catalogCollectionId: 'essay-1' });

test('the text lookup finds only ordinary sentences; the id lookup finds every live sentence', () => {
  const deleted = sentence('s0', TEXT, {}, true);
  const index = indexSavedSentences([realLife, deleted, essay, ordinary]);
  assert.deepEqual(index.byIdentity.get(normalizeSentenceIdentity(TEXT))?.map(item => item.data.id), ['s1']);
  assert.deepEqual([...index.byId.keys()], ['real-life-sentence:rl-7', 'essay-sentence:es-3', 's1']);
});

test('a word-card preview binds to an ordinary saved copy of its text, never to a catalog record', () => {
  const preview = sentence('sentence-preview:abc', TEXT);
  const resolve = (saved: StoredItem[], previewOnly: boolean) => {
    const index = indexSavedSentences(saved);
    return resolveSentenceUnderReview(
      preview, undefined, saved, text => index.byIdentity.get(normalizeSentenceIdentity(text))?.[0], previewOnly,
    );
  };

  const withOrdinary = resolve([realLife, essay, ordinary], false);
  assert.equal(withOrdinary.currentSentence?.data.id, 's1');
  assert.equal(withOrdinary.isSentencePreview, false);
  assert.equal(withOrdinary.sentenceExitLabel, 'Sentences');

  const catalogOnly = resolve([realLife, essay], true);
  assert.equal(catalogOnly.currentSentence?.data.id, 'sentence-preview:abc');
  assert.equal(catalogOnly.isSentencePreview, true);
  assert.equal(catalogOnly.catalogSentencePreview, false);
  assert.equal(catalogOnly.sentenceExitLabel, 'Word');
});
