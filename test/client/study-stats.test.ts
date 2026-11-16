import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewEvent, ReviewHistory, ReviewRating, StoredItem } from '../../types.ts';
import { combineStudyStats, computeHistoryStats, computeItemStats, computeStudyStats, countDueSpellings } from '../../services/studyStats.ts';
import { LibraryCounts } from '../../views/detail/LibraryCounts.tsx';

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
    vocab('a1', 'run', { strength: 90, reviews: 3, due: NOW - HOUR }),
    vocab('a2', 'run', { strength: 72, reviews: 2, due: NOW - DAY }),
    vocab('b', 'walk', { strength: 55, reviews: 1, due: NOW }),
    vocab('c', 'jump', { strength: 30, reviews: 2 }),
    vocab('d', 'skip', { strength: 12, reviews: 1 }),
    vocab('e', 'hop', { strength: 0, due: NOW - HOUR }),
  ];
  const stats = computeStudyStats(items, recentOnly([]), NOW);
  assert.deepEqual(stats.mastery, { grandmaster: 1, mastered: 1, proficient: 1, learning: 1, struggling: 1, new: 1 });
  // Both senses of "run" share one review slot, and "hop", never studied, waits with the new cards.
  assert.equal(stats.due, 2);
  assert.equal(stats.total, 6);
  assert.equal(stats.avgStrength, Math.round((90 + 72 + 55 + 30 + 12) / 6));
});

test('the due count takes each spelling once, reviewed and due, leaving out new, archived and deleted cards', () => {
  const items = [
    vocab('run-noun', 'Run', { reviews: 2, due: NOW - HOUR }),
    vocab('run-verb', ' run ', { reviews: 1, due: NOW }),
    vocab('walk', 'walk', { reviews: 3, due: NOW + 1 }),
    vocab('fresh', 'fresh', { due: NOW - DAY }),
    { ...vocab('kept', 'kept', { reviews: 1, due: NOW - HOUR }), isArchived: true },
    { ...vocab('gone', 'gone', { reviews: 1, due: NOW - HOUR }), isDeleted: true },
    vocab('jump', 'jump', { reviews: 1, due: NOW - DAY }),
  ];
  // run (both senses) and jump; walk isn't due yet, and fresh, never reviewed, waits with the new cards.
  assert.equal(countDueSpellings(items, NOW), 2);
  assert.equal(computeStudyStats(items, recentOnly([]), NOW).due, 2);
  assert.equal(countDueSpellings([], NOW), 0);
});

test('the card header\'s clock shows the dashboard\'s due count, and says it counts reviewed cards', t => {
  t.mock.method(Date, 'now', () => NOW);
  const items = [
    vocab('run', 'run', { strength: 80, reviews: 4, due: NOW - HOUR }),
    vocab('walk', 'walk', { strength: 40, reviews: 1, due: NOW - DAY }),
    vocab('fresh-1', 'fresh', { due: NOW - DAY }),
    vocab('fresh-2', 'new', { due: NOW }),
    { ...vocab('kept', 'kept', { strength: 90, reviews: 2, due: NOW - HOUR }), isArchived: true },
  ];
  const markup = renderToStaticMarkup(createElement(LibraryCounts, { savedItems: items }));
  const due = computeStudyStats(items.filter(item => !item.isArchived), recentOnly([]), NOW).due;
  assert.equal(due, 2);
  assert.match(markup, new RegExp(`<span class="text-amber-600 flex items-center gap-0\\.5" role="img" aria-label="${due} due \\(reviewed cards\\)" title="${due} due \\(reviewed cards\\)"><svg[^]*?</svg>${due}</span>$`));
  // The memorized count is as before: strength 70 or more, archived cards left out.
  assert.match(markup, /<span class="text-emerald-600 flex items-center gap-0\.5"><svg[^]*?<\/svg>1<\/span>/);
});

test('reviewed items band from each minimum strength down to struggling, and New counts the never reviewed', () => {
  const reviewed = [85, 84, 70, 69, 50, 49, 30, 29, 10, 9, 0, -2].map((strength, i) => vocab(String(i), String(i), { strength, reviews: 1 }));
  assert.deepEqual(computeStudyStats(reviewed, recentOnly([]), NOW).mastery, { grandmaster: 1, mastered: 2, proficient: 2, learning: 2, struggling: 5, new: 0 });
  const neverReviewed = [0, 7, 45, 90].map((strength, i) => vocab(`n${i}`, `n${i}`, { strength }));
  assert.deepEqual(computeStudyStats(neverReviewed, recentOnly([]), NOW).mastery, { grandmaster: 0, mastered: 0, proficient: 0, learning: 0, struggling: 0, new: 4 });
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

test('the numbers come from one pass over the items and one over the history, the lifetime total never below the items\' own', () => {
  const items = [vocab('a', 'run', { strength: 40, reviews: 6, streak: 2, due: NOW - HOUR }), vocab('b', 'walk', { reviews: 1 })];
  const history: ReviewHistory = { recent: [review(NOW - HOUR), review(NOW - 2 * DAY, 'again')], olderTimes: [midnight(20)], olderCount: 3 };
  const itemStats = computeItemStats(items, NOW);
  const historyStats = computeHistoryStats(history, NOW);
  assert.equal(itemStats.legacyReviewFloor, 7);
  assert.equal(historyStats.lifetimeCount, 5);
  assert.deepEqual(computeStudyStats(items, history, NOW), combineStudyStats(itemStats, historyStats));
  assert.equal(computeStudyStats(items, history, NOW).totalLifetimeReviews, 7, 'the items count more reviews than the history holds');
  assert.equal(computeStudyStats(items, { ...history, olderCount: 30 }, NOW).totalLifetimeReviews, 32);
});
