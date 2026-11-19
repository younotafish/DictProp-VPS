import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesReviewFilter,
  needsReview,
  ownedByToday,
  sentenceReviewState,
  summarizeReviewStates,
} from '../../services/sentenceReviewState.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { isDueForReview } from '../../services/studySession.ts';
import { countDueSpellings } from '../../services/studyStats.ts';
import type { SRSData } from '../../types.ts';
import { vocabItem } from '../support/loop-fixtures.ts';

const NOW = 2_000_000;
const DAY = 86_400_000;

const schedule = (totalReviews: number, nextReview: number, memoryStrength = 0): SRSData => ({
  ...SRSAlgorithm.createNew('sentence-1', 'sentence'),
  totalReviews,
  nextReview,
  memoryStrength,
});

test('a sentence is unreviewed until its first review, whatever its next review says', () => {
  assert.equal(sentenceReviewState(undefined, NOW), 'unreviewed');
  assert.equal(sentenceReviewState(schedule(0, NOW - 1), NOW), 'unreviewed');
  // A record made on a device whose clock ran ahead.
  assert.equal(sentenceReviewState(schedule(0, NOW + 60_000), NOW), 'unreviewed');
});

test('a reviewed sentence is due from its next review on, and memorized before it', () => {
  assert.equal(sentenceReviewState(schedule(1, NOW), NOW), 'due');
  assert.equal(sentenceReviewState(schedule(3, NOW - 1), NOW), 'due');
  assert.equal(sentenceReviewState(schedule(3, NOW + 1), NOW), 'memorized');
  assert.equal(sentenceReviewState({ ...schedule(2, 0), nextReview: undefined as unknown as number }, NOW), 'due');
});

test('each filter chip takes exactly its own state, and All takes every sentence', () => {
  const schedules = { unreviewed: schedule(0, NOW + 1), due: schedule(1, NOW - 1), memorized: schedule(1, NOW + 1) };
  for (const [state, srs] of Object.entries(schedules)) {
    assert.equal(matchesReviewFilter(srs, 'all', NOW), true);
    for (const filter of ['unreviewed', 'due', 'memorized'] as const) {
      assert.equal(matchesReviewFilter(srs, filter, NOW), filter === state, `${state} under ${filter}`);
    }
  }
  assert.equal(matchesReviewFilter(undefined, 'unreviewed', NOW), true);
});

test('a study run takes unreviewed and due sentences, not memorized ones', () => {
  assert.equal(needsReview(undefined, NOW), true);
  assert.equal(needsReview(schedule(0, NOW + 60_000), NOW), true);
  assert.equal(needsReview(schedule(4, NOW), NOW), true);
  assert.equal(needsReview(schedule(4, NOW + 1), NOW), false);
});

test('a summary counts each state and averages strength over every sentence', () => {
  const summary = summarizeReviewStates([
    undefined,
    schedule(0, NOW + 1, 80),
    schedule(2, NOW - 1, 40),
    schedule(5, NOW + 1, 130),
    schedule(1, NOW + 1, -20),
  ], NOW);
  assert.deepEqual(summary, {
    total: 5,
    reviewed: 3,
    unreviewed: 2,
    due: 1,
    memorized: 2,
    toReview: 3,
    // Unreviewed strength doesn't count, and each reviewed strength is held to 0-100: (40 + 100 + 0) / 5.
    masteryScore: 28,
  });
  assert.deepEqual(summarizeReviewStates([], NOW), {
    total: 0, reviewed: 0, unreviewed: 0, due: 0, memorized: 0, toReview: 0, masteryScore: 0,
  });
});

// Today's loop owns the learner's own sentences it practises and the ones it is done with (DESIGN-v3 D8): the Sentences
// tab, its badge and a lesson's counters never ask to review those. Words and phrases share the rule through classic
// Study, which reviews them whatever membership they carry.

/** One of the learner's own sentences in Today's practice since a day ago, and one marked then as one you can say. */
const practicingSentence = (srs: Partial<SRSData> = {}): SRSData =>
  ({ ...schedule(1, NOW - 60_000), practiceSince: NOW - DAY, practiceChangedAt: NOW - DAY, ...srs });
const sayableSentence = (srs: Partial<SRSData> = {}): SRSData =>
  ({ ...schedule(3, NOW - 60_000), sayableAt: NOW - DAY, practiceChangedAt: NOW - DAY, ...srs });

test('an own sentence Today practises, or one you can say, rests whatever its schedule says: never New or Due', () => {
  for (const srs of [practicingSentence(), sayableSentence(), practicingSentence({ nextReview: NOW + DAY })]) {
    assert.equal(ownedByToday(srs), true);
    assert.equal(sentenceReviewState(srs, NOW), 'memorized');
    assert.equal(needsReview(srs, NOW), false, 'not to review, so no orange row, Reviewed or badge count');
    assert.equal(matchesReviewFilter(srs, 'memorized', NOW), true);
    assert.equal(matchesReviewFilter(srs, 'due', NOW), false);
    assert.equal(matchesReviewFilter(srs, 'unreviewed', NOW), false);
  }
  // Today's membership comes from a review, so an owned record always has one; one that somehow doesn't still rests.
  assert.equal(sentenceReviewState(practicingSentence({ totalReviews: 0 }), NOW), 'memorized');
});

test('a sentence kept passive, or never decided in Today, is the Sentences tab\'s to review as before', () => {
  const kept = { ...schedule(2, NOW - 1), practiceChangedAt: NOW - DAY };
  assert.equal(ownedByToday(kept), false);
  assert.equal(sentenceReviewState(kept, NOW), 'due');
  assert.equal(sentenceReviewState({ ...kept, nextReview: NOW + 1 }, NOW), 'memorized');
  assert.equal(ownedByToday(schedule(4, NOW - 1)), false);
  assert.equal(ownedByToday(undefined), false);
});

test('a summary counts the sentences Today owns as memorized, never among those to review', () => {
  const summary = summarizeReviewStates([
    schedule(0, NOW),
    schedule(2, NOW - 1, 30),
    practicingSentence({ memoryStrength: 20 }),
    sayableSentence({ memoryStrength: 60 }),
  ], NOW);
  assert.deepEqual(summary, {
    total: 4, reviewed: 3, unreviewed: 1, due: 1, memorized: 2, toReview: 2, masteryScore: 28,
  });
});

test('a word or phrase with membership left from when Today took words stays due in classic Study', () => {
  for (const type of ['vocab', 'phrase'] as const) {
    for (const membership of [{ practiceSince: NOW - DAY }, { sayableAt: NOW - DAY }]) {
      const srs = { ...SRSAlgorithm.createNew('w-1', type), totalReviews: 2, nextReview: NOW - 1, practiceChangedAt: NOW - DAY, ...membership };
      assert.equal(ownedByToday(srs), false, type);
      assert.equal(sentenceReviewState(srs, NOW), 'due', type);
    }
  }
  // Card review's queue and its count of due spellings read the same rule.
  const word = vocabItem('braise-1', 'braise', {
    srs: { totalReviews: 2, nextReview: NOW - 1, practiceSince: NOW - DAY, practiceChangedAt: NOW - DAY },
  });
  assert.equal(isDueForReview(word, NOW), true);
  assert.equal(countDueSpellings([word], NOW), 1);
});
