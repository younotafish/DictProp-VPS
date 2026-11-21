import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredItem } from '../../types.ts';
import { isLoopEligible, isOwnSentence, localDayKey, localDayStart } from '../../services/learningLoop/standing.ts';
import { DAY, HOUR, memorized, practicing, reviewed, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

// Mid-afternoon local time, so the day has room on both sides.
const NOW = new Date(2026, 10, 18, 15, 0).getTime();

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

test('Today takes the learner\'s own live sentences with text, translated or not, and nothing else: no word cards', () => {
  assert.equal(isLoopEligible(vocabItem('w', 'crestfallen')), false, 'Today learns sentences, not single words');
  assert.equal(isLoopEligible(vocabItem('r', 'crestfallen', { srs: practicing(NOW - DAY) })), false, 'a word v3 put in practice');
  const phrase: StoredItem = {
    type: 'phrase',
    data: { id: 'p', query: 'give up', translation: '放弃', grammar: '', visualKeyword: '', pronunciation: '', timestamp: 0, vocabs: [] },
    srs: vocabItem('p', 'give up').srs,
    savedAt: 0,
  };
  assert.equal(isLoopEligible(phrase), false, 'phrases stay out');

  assert.equal(isLoopEligible(sentenceItem('s', 'She {{soaked up}} the sun.', { translation: '她晒着太阳。' })), true);
  // The lesson shows the analysis, or fetches it, as the Sentences tab does: a translation is no condition.
  assert.equal(isLoopEligible(sentenceItem('s', 'She soaked up the sun.', { translation: null })), true, 'no analysis yet');
  assert.equal(isLoopEligible(sentenceItem('s', 'She soaked up the sun.', { translation: '  ' })), true, 'an empty translation');
  assert.equal(isLoopEligible(sentenceItem('s', ' ', { translation: '译文' })), false, 'no text');
  assert.equal(isLoopEligible(sentenceItem('s', 'Text.', { isArchived: true })), false, 'archived');
  assert.equal(isLoopEligible(sentenceItem('s', 'Text.', { isDeleted: true })), false, 'deleted');
  // However a sentence was reviewed, and whatever membership v3 left on it, it stays Today's.
  for (const srs of [reviewed(NOW - DAY), memorized(NOW - DAY), practicing(NOW - DAY), sayable(NOW - HOUR)]) {
    assert.equal(isLoopEligible(sentenceItem('s', 'She soaked up the sun.', { srs })), true, JSON.stringify(srs));
  }
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
