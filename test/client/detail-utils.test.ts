import assert from 'node:assert/strict';
import test from 'node:test';
import { formatNextReview, formatRelativeTime, mergePreparedSentence } from '../../views/detail/detailUtils.ts';
import type { SentenceAnalysis, SentenceData, StoredItem } from '../../types.ts';
import { detailedAnalysis } from '../support/detail-view-fixtures.ts';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('the next review reads in whole days, hours or minutes, and as now once it is due', t => {
  t.mock.method(Date, 'now', () => NOW);
  assert.equal(formatRelativeTime(NOW - 1), 'now');
  assert.equal(formatRelativeTime(NOW), 'now');
  assert.equal(formatRelativeTime(NOW + MINUTE - 1), 'now');
  assert.equal(formatRelativeTime(NOW + MINUTE), '1m');
  assert.equal(formatRelativeTime(NOW + HOUR - 1), '59m');
  assert.equal(formatRelativeTime(NOW + HOUR), '1h');
  assert.equal(formatRelativeTime(NOW + DAY - 1), '23h');
  assert.equal(formatRelativeTime(NOW + 3 * DAY + 5 * HOUR), '3d');
});

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
