import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesReviewFilter,
  needsReview,
  sentenceReviewState,
  summarizeReviewStates,
} from '../../services/sentenceReviewState.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SRSData } from '../../types.ts';

const NOW = 2_000_000;

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
