import assert from 'node:assert/strict';
import test from 'node:test';
import {
  holdsSavedSentence, indexSavedSentences, lazySavedSentenceIndex, type SavedSentenceIndex,
} from '../../views/detail/useSavedSentenceIndex.ts';
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

/** indexSavedSentences, counting its builds. */
const countingBuilder = () => {
  const built: (readonly StoredItem[])[] = [];
  const build = (items: readonly StoredItem[]): SavedSentenceIndex => {
    built.push(items);
    return indexSavedSentences(items);
  };
  return { built, build };
};

test('the index builds nothing until a lookup reads it, then once for its library snapshot', () => {
  const { built, build } = countingBuilder();
  const snapshot = [realLife, essay, ordinary];
  const index = lazySavedSentenceIndex(snapshot, build);
  assert.equal(built.length, 0, 'nothing is normalized up front');
  assert.deepEqual(index.byIdentity.get(normalizeSentenceIdentity(TEXT))?.map(item => item.data.id), ['s1']);
  assert.deepEqual([...index.byId.keys()], ['real-life-sentence:rl-7', 'essay-sentence:es-3', 's1']);
  index.byIdentity.get('another sentence');
  assert.deepEqual(built, [snapshot], 'built once, for its own snapshot');
  // The next library change hands over a new snapshot, whose index waits for its own first lookup.
  const next = lazySavedSentenceIndex([...snapshot, sentence('s2', 'Another one.')], build);
  assert.equal(built.length, 1);
  assert.equal(next.byId.size, 4);
  assert.equal(built.length, 2);
});

test('a listen or a Got it on a saved or catalog sentence reads no index; only an example preview looks one up', () => {
  const { built, build } = countingBuilder();
  // A Got it hands the view a new snapshot of the library, with the reviewed sentence's new schedule.
  const reviewed = { ...ordinary, srs: { ...ordinary.srs, totalReviews: 4 } };
  for (const library of [[realLife, essay, ordinary], [realLife, essay, reviewed]]) {
    const index = lazySavedSentenceIndex(library, build);
    const show = (snapshot: StoredItem) => resolveSentenceUnderReview(
      snapshot, undefined, library, text => index.byIdentity.get(normalizeSentenceIdentity(text))?.[0], false,
    );
    assert.equal(show(library[2]).currentSentence?.data.id, 's1');
    assert.equal(show(realLife).catalogSentencePreview, true);
    // What the view's automatic writes check instead: whether the library holds the sentence.
    assert.equal(holdsSavedSentence(library, 's1'), true);
  }
  assert.equal(built.length, 0, 'no sentence normalized for a saved sentence or a catalog line');

  const library = [realLife, essay, ordinary];
  const index = lazySavedSentenceIndex(library, build);
  const preview = sentence('sentence-preview:abc', TEXT);
  for (let render = 0; render < 3; render++) {
    const shown = resolveSentenceUnderReview(
      preview, undefined, library, text => index.byIdentity.get(normalizeSentenceIdentity(text))?.[0], false,
    );
    assert.equal(shown.currentSentence?.data.id, 's1', 'the preview shows its saved copy');
  }
  assert.equal(built.length, 1, 'a preview builds the index once per snapshot, however often it renders');
});

test('the automatic writes hold a sentence live only while the library has it, not deleted', () => {
  const deleted = sentence('s0', TEXT, {}, true);
  const word = { type: 'vocab', data: { id: 'w1', word: 'meeting' }, savedAt: 1 } as unknown as StoredItem;
  const library = [deleted, ordinary, realLife, word];
  assert.equal(holdsSavedSentence(library, 's1'), true);
  assert.equal(holdsSavedSentence(library, 'real-life-sentence:rl-7'), true);
  assert.equal(holdsSavedSentence(library, 's0'), false, 'deleted on another device');
  assert.equal(holdsSavedSentence(library, 'w1'), false, 'not a sentence');
  assert.equal(holdsSavedSentence(library, 'sentence-preview:abc'), false, 'an unsaved example');
  assert.equal(holdsSavedSentence([], 's1'), false);
});
