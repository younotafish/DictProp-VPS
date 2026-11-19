import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatNextReview, mergePreparedSentence } from '../../views/detail/detailUtils.ts';
import { rememberedIntervalDays } from '../../views/detail/useRememberToast.ts';
import { RememberToast } from '../../views/detail/RememberToast.tsx';
import { updateAfterRating } from '../../services/fsrsScheduler.ts';
import { reviewIntervalDays } from '../../services/reviewTime.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceAnalysis, SentenceData, StoredItem } from '../../types.ts';
import { detailedAnalysis } from '../support/detail-view-fixtures.ts';

test('the Remembered toast says tomorrow, then days, then months to the half', () => {
  assert.equal(formatNextReview(0), 'tomorrow');
  assert.equal(formatNextReview(1), 'tomorrow');
  assert.equal(formatNextReview(2), 'in 2 days');
  assert.equal(formatNextReview(30), 'in 30 days');
  assert.equal(formatNextReview(31), 'in ~1 month');
  assert.equal(formatNextReview(45), 'in ~1.5 months');
  assert.equal(formatNextReview(60), 'in ~2 months');
  assert.equal(formatNextReview(200), 'in ~6.5 months');
});

test('the Remembered toast names no date for a sentence Today owns, which a Got it leaves Today\'s; any other card gets its interval', () => {
  const NOW = Date.UTC(2026, 10, 16, 9);
  const DAY = 86_400_000;
  // Met in a set three weeks ago: Practice (a triage Again), Passive (Good) or Can say it (Easy).
  const met = (type: 'vocab' | 'sentence', rating: 'again' | 'good' | 'easy') =>
    updateAfterRating(SRSAlgorithm.createNew(`${type}-${rating}`, type, NOW - 22 * DAY), rating, NOW - 21 * DAY, 'triage');
  // Got it is a classic review: it schedules the sentence and leaves it practicing, or one you can say.
  for (const rating of ['again', 'easy'] as const) {
    const gotIt = updateAfterRating(met('sentence', rating), 'good', NOW);
    assert.ok(gotIt.practiceSince !== undefined || gotIt.sayableAt !== undefined, `still Today's after ${rating}`);
    assert.equal(rememberedIntervalDays(gotIt, NOW), null, rating);
  }
  // A sentence kept passive, one never met in Today, and a word with membership left from when Today took words.
  const others = [
    updateAfterRating(met('sentence', 'good'), 'good', NOW),
    updateAfterRating(SRSAlgorithm.createNew('fresh', 'sentence', NOW - DAY), 'good', NOW),
    updateAfterRating(met('vocab', 'easy'), 'good', NOW),
  ];
  for (const next of others) {
    assert.equal(rememberedIntervalDays(next, NOW), reviewIntervalDays(next.nextReview, NOW));
  }
  // Without a date the toast says only Remembered!.
  const toast = (intervalDays: number | null) => renderToStaticMarkup(createElement(RememberToast, { intervalDays }));
  assert.match(toast(null), /Remembered!/);
  assert.doesNotMatch(toast(null), /Next review/);
  assert.match(toast(4), /Next review (?:<!-- -->)?in 4 days/);
});

const srs = (id: string, totalReviews: number) => ({
  id, type: 'sentence' as const, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews, correctStreak: 0, stability: 0,
});
const sentence = (data: Partial<SentenceData>, totalReviews = 0): StoredItem => ({
  type: 'sentence', data: { id: 's1', text: 'Text.', sourceWord: 'word', ...data }, srs: srs('s1', totalReviews), savedAt: 1,
});
const legacyAnalysis = { translation: 'old', americanEnglish: { status: 'shared', explanation: 'Fine.' }, terms: [], imagePrompt: 'p' } as SentenceAnalysis;

test('a prepared analysis replaces a legacy one, under the live copy\'s progress and fields', () => {
  const live = sentence({ analysis: legacyAnalysis, analysisGeneratedAt: 1, preferredSpeechStyle: 'casual' }, 6);
  const prepared = sentence({ analysis: detailedAnalysis, analysisGeneratedAt: 2, imageUrl: 'data:image/png;base64,AA' });
  const merged = mergePreparedSentence(live, prepared);
  const data = merged.data as SentenceData;
  assert.equal(data.analysis, detailedAnalysis);
  assert.equal(data.analysisGeneratedAt, 2);
  assert.equal(data.imageUrl, 'data:image/png;base64,AA');
  assert.equal(data.preferredSpeechStyle, 'casual');
  assert.equal(merged.srs.totalReviews, 6);
});

test('a detailed live analysis and a live image win over prepared ones', () => {
  const live = sentence({ analysis: detailedAnalysis, analysisGeneratedAt: 1, imageUrl: 'idb:stored' });
  const prepared = sentence({ analysis: legacyAnalysis, analysisGeneratedAt: 2, imageUrl: 'data:image/png;base64,AA' });
  const data = mergePreparedSentence(live, prepared).data as SentenceData;
  assert.equal(data.analysis, detailedAnalysis);
  assert.equal(data.analysisGeneratedAt, 1);
  assert.equal(data.imageUrl, 'idb:stored');
});

test('without anything prepared the live copy is returned as is', () => {
  const live = sentence({});
  assert.equal(mergePreparedSentence(live), live);
});
