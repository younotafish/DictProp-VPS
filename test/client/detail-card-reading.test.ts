import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoPlayTexts, exampleAt, keyVocabExample, preloadSession, pronounceOnCardChange, readableExamples, wordZoneBands, zoneText,
  type CardPronunciation,
} from '../../views/detail/cardReading.ts';
import type { SearchResult, StoredItem, VocabCard } from '../../types.ts';

const srs = (id: string, type: StoredItem['type']) => ({
  id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0,
});
const vocabCard = (id: string, examples: string[], extra: Partial<VocabCard> = {}): VocabCard => ({
  id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples,
  history: '', register: '', mnemonic: '', ...extra,
});
const vocab = (id: string, examples: string[], extra: Partial<VocabCard> = {}): StoredItem =>
  ({ type: 'vocab', data: vocabCard(id, examples, extra), srs: srs(id, 'vocab'), savedAt: 1 });
const phrase = (query: string, vocabs: VocabCard[], extra: Partial<SearchResult> = {}): StoredItem => ({
  type: 'phrase',
  data: { id: 'p', query, translation: '', grammar: '', visualKeyword: '', pronunciation: '', vocabs, timestamp: 1, ...extra },
  srs: srs('p', 'phrase'),
  savedAt: 1,
});

test('auto-play reads a word\'s first two examples, stripped, dropping empty ones but not padded ones', () => {
  assert.deepEqual(autoPlayTexts(vocab('a', ['The {{cat}} sat.', 'A [[rare]] word.', 'Third.'])), ['The cat sat.', 'A rare word.']);
  assert.deepEqual(autoPlayTexts(vocab('a', ['', 'Second.'])), ['Second.']);
  assert.deepEqual(autoPlayTexts(vocab('a', ['  ', 'Second.'])), ['  ', 'Second.']);
  assert.deepEqual(autoPlayTexts(phrase('run {{the}} gamut', [])), ['run the gamut']);
  assert.deepEqual(autoPlayTexts(phrase('', [])), []);
  assert.deepEqual(autoPlayTexts(null), []);
});

test('E reads the same two examples, trimmed, with blanks dropped', () => {
  assert.deepEqual(readableExamples(vocab('a', [' The {{cat}} sat. ', '  ', 'Third.'])), ['The cat sat.']);
  assert.deepEqual(readableExamples(phrase(' a phrase ', [])), ['a phrase']);
});

test('Cmd+1–4 read the raw example at that index from the full list', () => {
  const card = vocab('a', ['One', 'Two', 'Three']);
  assert.equal(exampleAt(card, 2), 'Three');
  assert.equal(exampleAt(card, 3), '');
  assert.equal(exampleAt(phrase('a phrase', []), 0), 'a phrase');
  assert.equal(exampleAt(phrase('a phrase', []), 1), '');
});

test('a phrase\'s Key Vocabulary example is the first non-blank one across its words', () => {
  assert.equal(keyVocabExample(phrase('q', [vocabCard('x', ['  ']), vocabCard('y', ['', ' The {{y}} one. '])]).data as SearchResult), 'The y one.');
  assert.equal(keyVocabExample(phrase('q', [vocabCard('x', [])]).data as SearchResult), undefined);
});

test('word cards draw one band per readable example up to two; phrases one, or two with a Key Vocabulary example', () => {
  assert.equal(wordZoneBands(vocab('a', [])), 0);
  assert.equal(wordZoneBands(vocab('a', ['One'])), 1);
  assert.equal(wordZoneBands(vocab('a', ['One', 'Two', 'Three'])), 2);
  assert.equal(wordZoneBands(phrase('q', [])), 1);
  assert.equal(wordZoneBands(phrase('q', [vocabCard('x', ['Example.'])])), 2);
  assert.equal(wordZoneBands(null), 0);
});

test('a band tap reads its example; a single example answers both bands, and a phrase falls back to itself', () => {
  const two = vocab('a', ['One', 'Two']);
  assert.equal(zoneText(two, 0), 'One');
  assert.equal(zoneText(two, 1), 'Two');
  assert.equal(zoneText(vocab('a', ['Only']), 1), 'Only');
  assert.equal(zoneText(vocab('a', []), 0), null);
  assert.equal(zoneText(phrase('q', [vocabCard('x', ['Ex.'])]), 0), 'q');
  assert.equal(zoneText(phrase('q', [vocabCard('x', ['Ex.'])]), 1), 'Ex.');
  assert.equal(zoneText(phrase('q', []), 1), 'q');
});

test('band taps read the examples the bands are counted from: after a blank first example, both bands read the second', () => {
  const blankFirst = vocab('a', ['', 'Two', 'Three']);
  assert.equal(wordZoneBands(blankFirst), 1);
  assert.equal(zoneText(blankFirst, 0), 'Two');
  assert.equal(zoneText(blankFirst, 1), 'Two');
  assert.equal(zoneText(vocab('a', ['One', '']), 1), 'One');
  // Without markers, as auto-play reads them; the reader strips them anyway.
  assert.equal(zoneText(vocab('a', ['The {{cat}} sat.', 'A [[rare]] word.']), 1), 'A rare word.');
});

test('the auto-play preload takes listed sentences in sentence review, else each card\'s auto-play texts, and stored pictures', () => {
  const sentence = (id: string, text: string, imageUrl?: string): StoredItem => ({
    type: 'sentence', data: { id, text, sourceWord: 'w', ...(imageUrl ? { imageUrl } : {}) }, srs: srs(id, 'sentence'), savedAt: 1,
  });
  const review = preloadSession([sentence('s1', 'One {{x}}.', 'idb:stored'), sentence('s2', '', 'server:has_image:4'), sentence('s3', 'Three.', 'data:image/png;base64,AA')], true);
  assert.deepEqual(review.texts, ['One {{x}}.', '', 'Three.']);
  assert.deepEqual([...review.images], [['s1', undefined], ['s2', '4']]);

  const cards = preloadSession([vocab('a', ['A {{b}}.', 'C.'], { imageUrl: 'server:has_image' }), phrase('q', [], { imageUrl: 'server:has_image:' })], false);
  assert.deepEqual(cards.texts, ['A b.', 'C.', 'q']);
  assert.deepEqual([...cards.images], [['p', '']], 'an unversioned server marker is not preloaded');
});

test('the word card says its word once per card, never over example auto-play, and not when auto-play stops on it', () => {
  // The card view's effect: each change of card or of auto-play asks once; a card it said, or auto-play read, is the last.
  let lastKey: string | null = null;
  const show = (cardKey: string, examplesPlaying: boolean): CardPronunciation => {
    const action = pronounceOnCardChange({ cardKey, lastKey, examplesPlaying });
    if (action !== 'skip') lastKey = cardKey;
    return action;
  };
  assert.equal(show('0:0:gamut', false), 'say', 'the card it opens on');
  assert.equal(show('0:0:gamut', true), 'handled', 'auto-play starts on it');
  assert.equal(show('1:0:sway', true), 'handled', 'auto-play moves on and reads the next card');
  assert.equal(show('1:0:sway', false), 'skip', 'stopping auto-play doesn\'t say the word');
  assert.equal(show('2:0:tilt', false), 'say', 'the next card, by hand');
  assert.equal(show('1:0:sway', false), 'say', 'and back to the last one');
  assert.equal(show('1:1:sway', false), 'say', 'another meaning of the same word');
});
