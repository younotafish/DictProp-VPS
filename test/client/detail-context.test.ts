import assert from 'node:assert/strict';
import test from 'node:test';
import { findInDetailContext, withoutCard, withoutSentence, type DetailContext } from '../../hooks/useDetailView.ts';
import type { ItemGroup, StoredItem } from '../../types.ts';

const srs = (id: string) => ({
  id, type: 'vocab' as const, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0,
});
const card = (id: string, word = id): StoredItem => ({
  type: 'vocab',
  data: {
    id, word, sense: `${id} sense`, chinese: '', ipa: '', definition: '', forms: [], wordFamily: [], synonyms: [], antonyms: [],
    confusables: [], examples: [], history: '', register: '', mnemonic: '',
  },
  srs: srs(id),
  savedAt: 1,
});
const sentence = (id: string): StoredItem => ({
  type: 'sentence', data: { id, text: `Sentence ${id}.`, sourceWord: 'word' }, srs: { ...srs(id), type: 'sentence' }, savedAt: 1,
});
const group = (title: string, ...items: StoredItem[]): ItemGroup => ({ title, items });
const cards = (groups: ItemGroup[], groupIndex = 0, itemIndex = 0): DetailContext => ({ groups, groupIndex, itemIndex, openId: 1 });
const ids = (context: DetailContext | null) => context?.groups.map(g => g.items.map(item => item.data.id));

test('findInDetailContext finds a card by group and meaning, and a sentence by its place in the list', () => {
  const context = cards([group('a', card('a1'), card('a2')), group('b', card('b1'))]);
  assert.deepEqual(findInDetailContext(context, 'a2'), { groupIndex: 0, itemIndex: 1 });
  assert.deepEqual(findInDetailContext(context, 'b1'), { groupIndex: 1, itemIndex: 0 });
  assert.equal(findInDetailContext(context, 'missing'), null);

  const review: DetailContext = { ...cards([group('w', card('w')), group('w', card('w'))]), sentenceItems: [sentence('s1'), sentence('s2')] };
  assert.deepEqual(findInDetailContext(review, 's2'), { groupIndex: 1, itemIndex: 0 });
  // The source cards aren't what a sentence review holds.
  assert.equal(findInDetailContext(review, 'w'), null);
});

test('withoutCard drops the card, then any group it emptied, and keeps the opening position in range', () => {
  const context = cards([group('a', card('a1'), card('a2')), group('b', card('b1'))], 1, 0);
  const lessA2 = withoutCard(context, 'a2');
  assert.deepEqual(ids(lessA2), [['a1'], ['b1']]);
  assert.deepEqual([lessA2?.groupIndex, lessA2?.itemIndex], [1, 0]);

  const lessB1 = withoutCard(context, 'b1');
  assert.deepEqual(ids(lessB1), [['a1', 'a2']]);
  assert.deepEqual([lessB1?.groupIndex, lessB1?.itemIndex], [0, 0]);

  const onSecondMeaning = withoutCard(cards([group('a', card('a1'), card('a2'))], 0, 1), 'a2');
  assert.deepEqual([onSecondMeaning?.groupIndex, onSecondMeaning?.itemIndex], [0, 0]);
  assert.equal(onSecondMeaning?.openId, 1);
});

test('withoutCard returns the context itself when the card is absent, null for the last card, and leaves sentence review alone', () => {
  const context = cards([group('a', card('a1'))]);
  assert.equal(withoutCard(context, 'missing'), context);
  assert.equal(withoutCard(context, 'a1'), null);

  const review: DetailContext = { ...cards([group('a', card('a1'))]), sentenceItems: [sentence('s1')] };
  assert.equal(withoutCard(review, 'a1'), review);
});

test('withoutSentence drops the sentence with its aligned group, back to the first meaning, and closes after the last', () => {
  const review: DetailContext = {
    ...cards([group('one', card('w1')), group('two', card('w2')), group('three', card('w3'))], 2, 0),
    sentenceItems: [sentence('s1'), sentence('s2'), sentence('s3')],
  };
  const lessS3 = withoutSentence(review, 's3');
  assert.deepEqual(lessS3?.sentenceItems?.map(s => s.data.id), ['s1', 's2']);
  assert.deepEqual(ids(lessS3), [['w1'], ['w2']]);
  assert.deepEqual([lessS3?.groupIndex, lessS3?.itemIndex], [1, 0]);

  const lessS1 = withoutSentence(review, 's1');
  assert.deepEqual(ids(lessS1), [['w2'], ['w3']]);
  assert.equal(lessS1?.groupIndex, 1);

  assert.equal(withoutSentence(review, 'missing'), review);
  const last: DetailContext = { ...cards([group('one', card('w1'))]), sentenceItems: [sentence('s1')] };
  assert.equal(withoutSentence(last, 's1'), null);

  const wordCards = cards([group('a', card('a1'))]);
  assert.equal(withoutSentence(wordCards, 'a1'), wordCards);
});

test('withoutSentence keeps a Today unit\'s session and Back label on the run that remains', () => {
  const unit: DetailContext = {
    ...cards([group('w', card('w')), group('w', card('w'))]),
    sentenceItems: [sentence('s1'), sentence('s2')],
    reviewSessionId: 'set:unit-1',
    exitLabel: 'Today',
  };
  const rest = withoutSentence(unit, 's1');
  assert.equal(rest?.reviewSessionId, 'set:unit-1');
  assert.equal(rest?.exitLabel, 'Today');
  assert.deepEqual(rest?.sentenceItems?.map(item => item.data.id), ['s2']);
});
