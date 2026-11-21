import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesReviewFilter,
  needsReview,
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

// Today's v3 loop left membership on some schedules (practiceSince, sayableAt, practiceChangedAt), and a Got it leaves
// it there. No count reads it: a sentence is new, due or memorized by its reviews and dates alone, so the Sentences
// tab, its badge, a lesson's counters and Today's units agree, and words and phrases go by the same rule.

/** The membership a v3 set left a day ago: in practice, marked as one you can say, or kept passive. */
const MEMBERSHIP = {
  practicing: { practiceSince: NOW - DAY, practiceChangedAt: NOW - DAY },
  sayable: { sayableAt: NOW - DAY, practiceChangedAt: NOW - DAY },
  passive: { practiceChangedAt: NOW - DAY },
} satisfies Record<string, Partial<SRSData>>;

test('a sentence carrying membership from Today\'s v3 loop is new, due or memorized by its reviews and dates alone', () => {
  for (const [kind, membership] of Object.entries(MEMBERSHIP)) {
    const fresh = { ...schedule(0, NOW + DAY), ...membership };
    const due = { ...schedule(3, NOW - 60_000), ...membership };
    const resting = { ...schedule(3, NOW + DAY), ...membership };
    const schedules = [fresh, due, resting];
    assert.deepEqual(schedules.map(srs => sentenceReviewState(srs, NOW)), ['unreviewed', 'due', 'memorized'], kind);
    // To review, so an orange row with Reviewed on the Sentences tab, a badge count and a place in a unit.
    assert.deepEqual(schedules.map(srs => needsReview(srs, NOW)), [true, true, false], kind);
    assert.equal(matchesReviewFilter(due, 'due', NOW), true, kind);
    assert.equal(matchesReviewFilter(resting, 'memorized', NOW), true, kind);
  }
});

test('a summary counts the sentences carrying membership by their dates, as it counts any other', () => {
  const summary = summarizeReviewStates([
    schedule(0, NOW),
    { ...schedule(2, NOW - 1, 30), ...MEMBERSHIP.practicing },
    { ...schedule(3, NOW - 1, 20), ...MEMBERSHIP.sayable },
    { ...schedule(3, NOW + DAY, 60), ...MEMBERSHIP.sayable },
  ], NOW);
  assert.deepEqual(summary, {
    total: 4, reviewed: 3, unreviewed: 1, due: 2, memorized: 1, toReview: 3, masteryScore: 28,
  });
});

test('a word or phrase with membership left from when Today took words stays due in classic Study', () => {
  for (const type of ['vocab', 'phrase'] as const) {
    for (const membership of [{ practiceSince: NOW - DAY }, { sayableAt: NOW - DAY }]) {
      const srs = { ...SRSAlgorithm.createNew('w-1', type), totalReviews: 2, nextReview: NOW - 1, practiceChangedAt: NOW - DAY, ...membership };
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
