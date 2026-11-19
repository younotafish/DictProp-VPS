import assert from 'node:assert/strict';
import test from 'node:test';
import type { SentenceData, StoredItem } from '../../types.ts';
import {
  GRADUATION_DOTS,
  graduationDots,
  isLoopEligible,
  isOwnSentence,
  isPracticeDue,
  itemStanding,
  localDayKey,
  localDayStart,
  sentenceTranslation,
} from '../../services/learningLoop/standing.ts';
import { DAY, HOUR, passive, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

// Mid-afternoon local time, so the day has room on both sides.
const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const MIDNIGHT = new Date(2026, 10, 18).getTime();

/** Runs `check` with the device's clock in `zone`, as due-label.test.ts does for daylight saving. */
function inZone(zone: string, check: () => void) {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    check();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

test('the loop takes the learner\'s own live sentences with a translation, nothing else: no word cards', () => {
  assert.equal(isLoopEligible(vocabItem('w', 'crestfallen')), false, 'Today learns sentences, not single words');
  assert.equal(isLoopEligible(vocabItem('r', 'crestfallen', { srs: practicing(NOW - DAY) })), false, 'a word put in practice before');
  const phrase: StoredItem = {
    type: 'phrase',
    data: { id: 'p', query: 'give up', translation: '放弃', grammar: '', visualKeyword: '', pronunciation: '', timestamp: 0, vocabs: [] },
    srs: vocabItem('p', 'give up').srs,
    savedAt: 0,
  };
  assert.equal(isLoopEligible(phrase), false, 'phrases stay out');

  assert.equal(isLoopEligible(sentenceItem('s', 'She {{soaked up}} the sun.', { translation: '她晒着太阳。' })), true);
  assert.equal(isLoopEligible(sentenceItem('s', 'She soaked up the sun.', { translation: null })), false, 'no analysis yet');
  assert.equal(isLoopEligible(sentenceItem('s', 'She soaked up the sun.', { translation: '  ' })), false, 'an empty translation');
  assert.equal(isLoopEligible(sentenceItem('s', ' ', { translation: '译文' })), false, 'no text');
  assert.equal(isLoopEligible(sentenceItem('s', 'Text.', { isArchived: true })), false, 'archived');
  assert.equal(isLoopEligible(sentenceItem('s', 'Text.', { isDeleted: true })), false, 'deleted');
  assert.equal(isLoopEligible(sentenceItem('s', 'She soaked up the sun.', { srs: reviewed(NOW - DAY) })), true, 'reviewed with Got it before');
});

test('catalog lines are never the learner\'s own sentences, by any of their catalog fields', () => {
  const realLife = sentenceItem('real-life-sentence:cafe:order:01', 'Can I {{get}} a latte?', {
    catalogKind: 'real-life', catalogSentenceId: 'cafe:order:01', catalogCollectionId: 'cafe',
  });
  // The first Real Life records were saved before catalogKind existed.
  const early = sentenceItem('real-life-sentence:cafe:order:02', 'To go, please.', {
    catalogSentenceId: 'cafe:order:02', catalogCollectionId: 'cafe',
  });
  const essay = sentenceItem('essay-sentence:e1:s1', 'It began.', {
    catalogKind: 'essay', catalogSentenceId: 'e1:s1', catalogCollectionId: 'e1',
  });
  // Damaged records: a catalog field without the id that goes with it.
  const kindOnly = sentenceItem('s-kind', 'Line.', { catalogKind: 'real-life' });
  const lineOnly = sentenceItem('s-line', 'Line.', { catalogSentenceId: 'x' });
  for (const item of [realLife, early, essay, kindOnly, lineOnly]) {
    assert.equal(isOwnSentence(item), false, item.data.id);
    assert.equal(isLoopEligible(item), false, item.data.id);
  }
  assert.equal(isOwnSentence(sentenceItem('own', 'Mine.')), true);
  assert.equal(isOwnSentence(vocabItem('w', 'word')), false);
});

test('a sentence\'s translation comes from its analysis, trimmed, and is empty without one', () => {
  assert.equal(sentenceTranslation(sentenceItem('s', 'x', { translation: ' 她晒着太阳。 ' }).data as SentenceData), '她晒着太阳。');
  assert.equal(sentenceTranslation(sentenceItem('s', 'x', { translation: null }).data as SentenceData), '');
});

test('an item\'s standing comes from its Today decisions, never from its classic reviews', () => {
  assert.equal(itemStanding(sentenceItem('n', 'New.')), 'new');
  assert.equal(itemStanding(sentenceItem('g', 'Got it before.', { srs: reviewed(NOW - DAY, { totalReviews: 3 }) })), 'new');
  assert.equal(itemStanding(sentenceItem('p', 'Practice.', { srs: practicing(NOW - DAY) })), 'practicing');
  assert.equal(itemStanding(sentenceItem('s', 'Say.', { srs: sayable(NOW - DAY) })), 'sayable');
  assert.equal(itemStanding(sentenceItem('k', 'Kept passive.', { srs: passive(NOW - DAY) })), 'passive');
});

test('a practice item is due when its time has come and it wasn\'t reviewed since local midnight', () => {
  const item = (srs: Parameters<typeof practicing>[1], extra: { isArchived?: boolean } = {}) =>
    sentenceItem('p', 'Practice it.', { srs: practicing(NOW - 3 * DAY, srs), ...extra });
  assert.equal(isPracticeDue(item({ nextReview: NOW - HOUR, lastReviewDate: MIDNIGHT - 1 }), NOW), true);
  assert.equal(isPracticeDue(item({ nextReview: NOW, lastReviewDate: MIDNIGHT - DAY }), NOW), true, 'due this moment');
  assert.equal(isPracticeDue(item({ nextReview: NOW + 1, lastReviewDate: MIDNIGHT - DAY }), NOW), false, 'not yet');
  // Joined, practiced or missed today: its 10-minute step is today's repetition, and it waits for tomorrow.
  assert.equal(isPracticeDue(item({ nextReview: NOW - HOUR, lastReviewDate: MIDNIGHT }), NOW), false);
  assert.equal(isPracticeDue(item({ nextReview: NOW - HOUR, lastReviewDate: MIDNIGHT - 1 }, { isArchived: true }), NOW), false);
  assert.equal(isPracticeDue(sentenceItem('r', 'Got it.', { srs: reviewed(MIDNIGHT - DAY, { nextReview: NOW - HOUR }) }), NOW), false);
  assert.equal(isPracticeDue(sentenceItem('k', 'Passive.', { srs: passive(MIDNIGHT - DAY, { nextReview: NOW - HOUR }) }), NOW), false);
  assert.equal(isPracticeDue(sentenceItem('s', 'Say.', { srs: sayable(MIDNIGHT - DAY, { nextReview: NOW - HOUR }) }), NOW), false);
  // A word left in practice by the first build of Today is no longer the loop's.
  assert.equal(isPracticeDue(vocabItem('w', 'word', { srs: practicing(NOW - 3 * DAY, { nextReview: NOW - HOUR, lastReviewDate: MIDNIGHT - 1 }) }), NOW), false);
  // A caller checking many items passes today's midnight once.
  assert.equal(isPracticeDue(item({ nextReview: NOW - HOUR, lastReviewDate: MIDNIGHT - 1 }), NOW, MIDNIGHT), true);
});

test('local days count in calendar days, across a daylight-saving change too', () => {
  inZone('America/New_York', () => {
    // New York falls back on 2026-11-01: that day has 25 hours.
    const fallBack = new Date(2026, 10, 1, 12).getTime();
    assert.equal(localDayStart(fallBack), new Date(2026, 10, 1).getTime());
    assert.equal(localDayStart(fallBack, 1) - localDayStart(fallBack), 25 * HOUR);
    assert.equal(localDayKey(localDayStart(fallBack, 1)), '2026-11-02');
    assert.equal(localDayKey(localDayStart(fallBack, -1)), '2026-10-31');
    assert.equal(new Date(localDayStart(fallBack, 1)).getHours(), 0);
    // It springs forward on 2026-03-08: 23 hours.
    const springForward = new Date(2026, 2, 8, 12).getTime();
    assert.equal(localDayStart(springForward, 1) - localDayStart(springForward), 23 * HOUR);
    assert.equal(localDayKey(springForward), '2026-03-08');
  });
  assert.equal(localDayKey(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');
  assert.equal(localDayKey(new Date(2026, 11, 31).getTime()), '2026-12-31');
});

test('graduation dots fill from one, at 1.5, 5, 12 and 21 days of stability', () => {
  assert.equal(GRADUATION_DOTS, 5);
  const cases: [stability: number | undefined, dots: number][] = [
    [undefined, 1], [0.21, 1], [1.49, 1], [1.5, 2], [4.9, 2], [5, 3], [11.9, 3], [12, 4], [20.9, 4], [21, 5], [400, 5], [Number.NaN, 1],
  ];
  for (const [stability, dots] of cases) assert.equal(graduationDots(stability), dots, String(stability));
});
