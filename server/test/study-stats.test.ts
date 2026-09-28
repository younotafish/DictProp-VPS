import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent, ReviewHistory, ReviewRating, StoredItem } from '../../types.ts';
import { computeStudyStats } from '../../services/studyStats.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Mid-afternoon local time, so "today" has room on both sides.
const NOW = new Date(2026, 8, 28, 15, 30).getTime();

const midnight = (daysAgo: number) => {
  const now = new Date(NOW);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
};

function vocab(
  id: string,
  word: string,
  { strength = 0, reviews = 0, streak = 0, due = NOW + DAY }: { strength?: number; reviews?: number; streak?: number; due?: number } = {},
): StoredItem {
  return {
    type: 'vocab',
    data: {
      id, word, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
      history: '', register: '', mnemonic: '',
    },
    savedAt: 0,
    srs: {
      id, type: 'vocab', nextReview: due, interval: 0, memoryStrength: strength, lastReviewDate: 0,
      totalReviews: reviews, correctStreak: streak, stability: 1,
    },
  };
}

let nextEventId = 0;
const review = (reviewedAt: number, rating: ReviewRating = 'good'): ReviewEvent => ({
  id: String(nextEventId++), itemId: 'x', itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 0, rating,
});
const recentOnly = (recent: ReviewEvent[]): ReviewHistory => ({ recent, olderTimes: [], olderCount: 0 });

test('study stats bucket items by memory strength and count due spellings once', () => {
  const items = [
    vocab('a1', 'run', { strength: 90, due: NOW - HOUR }),
    vocab('a2', 'run', { strength: 72, due: NOW - DAY }),
    vocab('b', 'walk', { strength: 55, due: NOW }),
    vocab('c', 'jump', { strength: 30 }),
    vocab('d', 'skip', { strength: 12 }),
    vocab('e', 'hop', { strength: 0 }),
  ];
  const stats = computeStudyStats(items, recentOnly([]), NOW);
  assert.deepEqual(
    [stats.grandmaster, stats.mastered, stats.proficient, stats.learning, stats.struggling, stats.newItems],
    [1, 1, 1, 1, 1, 1],
  );
  assert.equal(stats.due, 2); // both senses of "run" share one review slot
  assert.equal(stats.total, 6);
  assert.equal(stats.avgStrength, Math.round((90 + 72 + 55 + 30 + 12) / 6));
});

test('study stats pick the three most reviewed items, earlier items first on ties', () => {
  const items = [
    vocab('a', 'a', { reviews: 4 }),
    vocab('b', 'b', { reviews: 9 }),
    vocab('c', 'c', { reviews: 4 }),
    vocab('d', 'd', { reviews: 4 }),
    vocab('e', 'e', { reviews: 12, streak: 7 }),
  ];
  const stats = computeStudyStats(items, recentOnly([]), NOW);
  assert.deepEqual(stats.mostReviewed.map(item => item.data.id), ['e', 'b', 'a']);
  assert.equal(stats.longestStreak, 7);
  assert.equal(stats.totalLifetimeReviews, 33); // no history yet, so the per-item counts stand in
});

test('study streak counts back from today, or from yesterday before today is studied', () => {
  const streakOf = (daysAgo: number[]) =>
    computeStudyStats([], recentOnly(daysAgo.map(days => review(midnight(days) + HOUR))), NOW).streak;
  assert.equal(streakOf([0, 1, 2, 4]), 3);
  assert.equal(streakOf([1, 2]), 2);
  assert.equal(streakOf([0]), 1);
  assert.equal(streakOf([2, 3]), 0);
  assert.equal(streakOf([]), 0);
});

test('study stats bucket reviews by local calendar day, oldest first', () => {
  const events = [
    review(midnight(0)), // the first instant of today
    review(midnight(0) - 1), // the last instant of yesterday
    review(midnight(6) + 5 * HOUR),
    review(midnight(7) + 5 * HOUR), // outside the chart
    review(midnight(0) + DAY + HOUR), // tomorrow, from a skewed clock
  ];
  const stats = computeStudyStats([], recentOnly(events), NOW);
  assert.deepEqual(stats.last7Days.map(entry => entry.reviews), [1, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual(stats.last7Days.map(entry => entry.day), [6, 5, 4, 3, 2, 1, 0].map(midnight));
  // Each entry names its own weekday in local time.
  assert.equal(new Date(stats.last7Days[6].day).getDay(), new Date(NOW).getDay());
});

test('weekly stats cover the last seven days and the share not rated again', () => {
  const events = [
    review(NOW - 8 * DAY, 'again'),
    review(NOW - 6 * DAY, 'again'),
    review(NOW - 2 * DAY, 'good'),
    review(NOW - HOUR, 'hard'),
    review(NOW - HOUR, 'easy'),
  ];
  const stats = computeStudyStats([vocab('a', 'a', { reviews: 1 })], recentOnly(events), NOW);
  assert.equal(stats.weeklyReviews, 4);
  assert.equal(stats.weeklyRecallRate, 75);
  assert.equal(stats.totalLifetimeReviews, 5);
});

test('study stats match the per-event date formatting they replace', () => {
  let seed = 11;
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  const dateKey = (time: number) => {
    const d = new Date(time);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  const gap = dateKey(midnight(5)); // a day off, so the streak has somewhere to end
  const events = Array.from({ length: 3_000 }, () =>
    review(NOW - Math.floor(rand() * 400 * DAY), rand() < 0.2 ? 'again' : 'good'))
    .filter(event => dateKey(event.reviewedAt) !== gap);
  const reviewDays = new Set(events.map(event => dateKey(event.reviewedAt)));
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const day = new Date(NOW);
    day.setDate(day.getDate() - i);
    if (reviewDays.has(dateKey(day.getTime()))) streak++;
    else if (i > 0) break;
  }
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(NOW);
    day.setDate(day.getDate() - (6 - i));
    return events.filter(event => dateKey(event.reviewedAt) === dateKey(day.getTime())).length;
  });

  // The server sends reviews older than the recent ones as bare times.
  const recentSince = NOW - 8 * DAY;
  const older = events.filter(event => event.reviewedAt < recentSince);
  const stats = computeStudyStats([], {
    recent: events.filter(event => event.reviewedAt >= recentSince),
    olderTimes: older.map(event => event.reviewedAt).sort((a, b) => a - b),
    olderCount: older.length,
  }, NOW);
  assert.equal(stats.streak, streak);
  assert.deepEqual(stats.last7Days.map(entry => entry.reviews), last7);
  assert.equal(stats.totalLifetimeReviews, events.length);
});

test('older reviews, known only by when they happened, extend the streak and the lifetime total', () => {
  const recent = [0, 1, 2, 3, 4, 5, 6, 7].map(days => review(midnight(days) + HOUR, days === 0 ? 'again' : 'good'));
  const olderTimes = [8, 9, 9, 10].map(days => midnight(days) + HOUR);
  const stats = computeStudyStats([], { recent, olderTimes, olderCount: 1_000 }, NOW);
  assert.equal(stats.streak, 11);
  // A week before 15:30 today is after that day's 01:00 review.
  assert.equal(stats.weeklyReviews, 7);
  assert.equal(stats.weeklyRecallRate, 86);
  assert.equal(stats.totalLifetimeReviews, 1_008); // most older reviews are beyond a streak's reach
});
