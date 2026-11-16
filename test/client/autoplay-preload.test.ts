import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRELOAD_MIN_CARDS, estimateReadMs, needsReplan, planAutoplayPreload, type PreloadCard, type PreloadInput,
} from '../../services/audio/autoplayPreload.ts';
import { EMPTY_CARD_MS } from '../../services/audio/autoplayController.ts';

// services/audio/autoplayPreload.ts: what sentence auto-play preloads, planned from where it starts and what's left of
// the Duration.

const MINUTE = 60_000;
/** Thirteen words: five seconds at normal speed. */
const THIRTEEN_WORDS = 'one two three four five six seven eight nine ten eleven twelve thirteen';
/** Sentences of thirteen words each, told apart by their last word. */
const sentences = (count: number, extra: (index: number) => Partial<PreloadCard> = () => ({})): PreloadCard[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `s${index}`, texts: [`one two three four five six seven eight nine ten eleven twelve number-${index}`], ...extra(index),
  }));
const review = (cards: PreloadCard[], overrides: Partial<PreloadInput> = {}): PreloadInput => ({
  cards, fromIndex: 0, remainingMs: 20 * MINUTE, repeats: 1, gapMs: 2000, cardGapMs: 2000, rate: 1, currentStyle: 'clear',
  ...overrides,
});

test('a read takes its word count at 2.6 words a second, faster at a higher speed', () => {
  assert.equal(estimateReadMs(THIRTEEN_WORDS, 1), 5000);
  assert.equal(estimateReadMs(THIRTEEN_WORDS, 2), 2500);
  assert.equal(estimateReadMs(`  ${THIRTEEN_WORDS}  `, 1), 5000, 'spaces aren\'t words');
  assert.equal(estimateReadMs('', 1), 0);
});

test('a 20-minute auto-play on a 4,000-sentence list plans what 1.25 times 20 minutes reaches, current sentence first', () => {
  const cards = sentences(4000);
  // Each card is read once (5 s) with the 2 s gap after it: 7 s. 25 minutes of them is 214.3 cards, so 215.
  const plan = planAutoplayPreload(review(cards, { fromIndex: 1200 }));
  assert.equal(plan.fromIndex, 1200);
  assert.equal(plan.toIndex - plan.fromIndex, 215);
  assert.equal(plan.estimateMs, 215 * 7000);
  assert.equal(plan.clips[0].text, cards[1200].texts[0], 'the sentence on screen comes first');
  assert.ok(plan.toIndex < cards.length, 'never the whole list');
});

test('repeats, the interval and the voice speed change what fits', () => {
  const cards = sentences(1000);
  const base = planAutoplayPreload(review(cards));
  assert.ok(planAutoplayPreload(review(cards, { repeats: 3 })).toIndex < base.toIndex);
  assert.ok(planAutoplayPreload(review(cards, { gapMs: 10_000, cardGapMs: 10_000 })).toIndex < base.toIndex);
  assert.ok(planAutoplayPreload(review(cards, { rate: 2 })).toIndex > base.toIndex);
});

test('at least ten cards, however little time is left, and never past the end of the list', () => {
  assert.equal(planAutoplayPreload(review(sentences(50), { remainingMs: 0 })).toIndex, PRELOAD_MIN_CARDS);
  const short = planAutoplayPreload(review(sentences(4), { remainingMs: 0 }));
  assert.equal(short.toIndex, 4);
  assert.equal(short.clips.length, 4);
  const atTheEnd = planAutoplayPreload(review(sentences(4), { fromIndex: 9 }));
  assert.deepEqual([atTheEnd.fromIndex, atTheEnd.toIndex, atTheEnd.clips.length], [4, 4, 0]);
});

test('each sentence is fetched in the voice it will play in: its own, else the one the sentence before left', () => {
  const styles: Array<PreloadCard['preferredStyle']> = [undefined, 'casual', undefined, 'clear', undefined];
  const cards = sentences(5, index => ({ preferredStyle: styles[index] }));
  const plan = planAutoplayPreload(review(cards, { currentStyle: 'clear', remainingMs: 0 }));
  assert.deepEqual(plan.clips.map(clip => clip.style), ['clear', 'casual', 'casual', 'clear', 'clear']);
  const fromCasual = planAutoplayPreload(review(cards, { currentStyle: 'casual', remainingMs: 0 }));
  assert.equal(fromCasual.clips[0].style, 'casual', 'from the style now on');
});

test('the sentence on screen is fetched in the style now on, even when a click set it apart from its own voice', () => {
  const styles: Array<PreloadCard['preferredStyle']> = ['clear', undefined, undefined, 'clear', undefined];
  const cards = sentences(5, index => ({ preferredStyle: styles[index] }));
  const plan = planAutoplayPreload(review(cards, { currentStyle: 'casual', remainingMs: 0 }));
  assert.deepEqual(plan.clips.map(clip => clip.style), ['casual', 'casual', 'casual', 'clear', 'clear']);
});

test('a text comes once per voice, and the pictures of the cards covered come with their versions', () => {
  const cards: PreloadCard[] = [
    { id: 'a', texts: ['Same.'], image: { id: 'a', version: '3' } },
    { id: 'b', texts: ['Same.'] },
    { id: 'c', texts: ['Same.'], preferredStyle: 'casual', image: { id: 'c' } },
  ];
  const plan = planAutoplayPreload(review(cards, { remainingMs: 0 }));
  assert.deepEqual(plan.clips, [{ text: 'Same.', style: 'clear' }, { text: 'Same.', style: 'casual' }]);
  assert.deepEqual([...plan.images], [['a', '3'], ['c', undefined]]);
});

test('word cards: each example its repeats with the gap between reads, a short beat after the card, an empty card a moment', () => {
  const card: PreloadCard = { id: 'w', texts: [THIRTEEN_WORDS, THIRTEEN_WORDS] };
  const plan = planAutoplayPreload({ ...review([card, { id: 'empty', texts: [] }], { remainingMs: 0 }), repeats: 2, gapMs: 3000, cardGapMs: 600 });
  // Four reads of 5 s, the three gaps between them, then the beat; then the empty card.
  assert.equal(plan.estimateMs, 4 * 5000 + 3 * 3000 + 600 + EMPTY_CARD_MS);
});

test('a longer Duration extends the plan from the same sentence, so the clips already planned come first again', () => {
  const cards = sentences(4000);
  const twenty = planAutoplayPreload(review(cards, { fromIndex: 10 }));
  const sixty = planAutoplayPreload(review(cards, { fromIndex: 10, remainingMs: 60 * MINUTE }));
  assert.ok(sixty.toIndex > twenty.toIndex);
  assert.deepEqual(sixty.clips.slice(0, twenty.clips.length), twenty.clips);
});

test('a card outside the plan needs a new one: a swipe back before it, or past its end', () => {
  const plan = planAutoplayPreload(review(sentences(100), { fromIndex: 20, remainingMs: 0 }));
  assert.deepEqual([plan.fromIndex, plan.toIndex], [20, 30]);
  assert.equal(needsReplan(plan, 20), false);
  assert.equal(needsReplan(plan, 29), false);
  assert.equal(needsReplan(plan, 19), true);
  assert.equal(needsReplan(plan, 30), true);
});
