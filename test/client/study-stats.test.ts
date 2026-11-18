import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewEvent, ReviewHistory, ReviewRating, ReviewTaskType, StoredItem } from '../../types.ts';
import {
  combineStudyStats,
  computeHistoryStats,
  computeItemStats,
  computeStudyStats,
  countDueSpellings,
  formatCountdown,
  isClassicStudyCard,
  nextStudyClockChange,
  startCaption,
  studyForecast,
} from '../../services/studyStats.ts';
import { LibraryCounts } from '../../views/detail/LibraryCounts.tsx';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';

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

/** The item in Today's loop: practicing, or one you can say. */
const inLoop = (item: StoredItem, membership: 'practicing' | 'sayable'): StoredItem => ({
  ...item,
  srs: { ...item.srs, ...(membership === 'practicing' ? { practiceSince: NOW - DAY } : { sayableAt: NOW - DAY }), practiceChangedAt: NOW - DAY },
});

let nextEventId = 0;
const review = (reviewedAt: number, rating: ReviewRating = 'good', taskType: ReviewTaskType = 'meaning'): ReviewEvent => ({
  id: String(nextEventId++), itemId: 'x', itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 0, rating, taskType,
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

test('a card never reviewed adds 0 to the average strength, as its badge shows it New at 0, whatever its seed stability stores', () => {
  // A newly saved word goes through SRSAlgorithm.ensure, which stores the seed stability's display strength.
  const saved = { ...vocab('new', 'fresh'), srs: SRSAlgorithm.ensure(SRSAlgorithm.createNew('new', 'vocab', NOW), 'new', 'vocab') };
  assert.equal(saved.srs.memoryStrength, 7);
  assert.equal(computeItemStats([saved], NOW).avgStrength, 0);
  const stats = computeItemStats([vocab('run', 'run', { strength: 40, reviews: 2 }), saved], NOW);
  assert.equal(stats.avgStrength, 20);
  assert.equal(stats.mastery.new, 1);
  assert.equal(stats.mastery.learning, 1);
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
    // Today's: practiced there, or done.
    inLoop(vocab('practice', 'practice', { reviews: 1, due: NOW - HOUR }), 'practicing'),
    inLoop(vocab('say', 'say', { reviews: 4, due: NOW - HOUR }), 'sayable'),
  ];
  // run (both senses) and jump; walk isn't due yet, fresh, never reviewed, enters through Today's sets, and Today
  // practices or is done with the last two.
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
  assert.match(markup, /<span class="text-emerald-600 flex items-center gap-0\.5"[^>]*><svg[^]*?<\/svg>1<\/span>/);
});

test('reviewed items band from each minimum strength down to struggling, and New counts the never reviewed', () => {
  const reviewed = [85, 84, 70, 69, 50, 49, 30, 29, 10, 9, 0, -2].map((strength, i) => vocab(String(i), String(i), { strength, reviews: 1 }));
  assert.deepEqual(computeStudyStats(reviewed, recentOnly([]), NOW).mastery, { grandmaster: 1, mastered: 2, proficient: 2, learning: 2, struggling: 5, new: 0 });
  const neverReviewed = [0, 7, 45, 90].map((strength, i) => vocab(`n${i}`, `n${i}`, { strength }));
  assert.deepEqual(computeStudyStats(neverReviewed, recentOnly([]), NOW).mastery, { grandmaster: 0, mastered: 0, proficient: 0, learning: 0, struggling: 0, new: 4 });
});

test('the most practiced are reviewed items only, so a new library lists the few it has reviewed', () => {
  const items = [vocab('walk', 'walk'), vocab('run', 'run', { reviews: 5 }), vocab('jump', 'jump'), vocab('hop', 'hop')];
  assert.deepEqual(computeStudyStats(items, recentOnly([]), NOW).mostReviewed.map(item => item.data.id), ['run']);
  assert.deepEqual(computeStudyStats([vocab('a', 'a'), vocab('b', 'b')], recentOnly([]), NOW).mostReviewed, []);
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
  assert.equal(stats.weeklyStudyRecallRate, 75);
  assert.equal(stats.totalLifetimeReviews, 5);
});

test('the week is the chart\'s seven days: at 21:00 a review 6 days 23 hours back and one stamped a day ahead count in neither', () => {
  const evening = new Date(2026, 8, 26, 21, 0).getTime();
  const sixDaysTwentyThreeHoursBack = review(evening - 6 * DAY - 23 * HOUR, 'again');
  const fromAClockAhead = review(evening + DAY);
  const inside = [review(evening - HOUR), review(new Date(2026, 8, 20, 0, 0).getTime(), 'again')];
  const stats = computeStudyStats([], recentOnly([sixDaysTwentyThreeHoursBack, fromAClockAhead, ...inside]), evening);
  assert.equal(stats.weeklyReviews, 2);
  assert.equal(stats.weeklyStudyRecallRate, 50);
  assert.equal(stats.last7Days.reduce((sum, day) => sum + day.reviews, 0), stats.weeklyReviews, 'the chart\'s total agrees');
});

test('the history\'s numbers depend only on the day, so any time that day gives the same ones', () => {
  const events = [review(midnight(0) + HOUR), review(midnight(3) + 20 * HOUR, 'again'), review(midnight(6) + 2 * HOUR)];
  const history: ReviewHistory = { recent: events, olderTimes: [midnight(9) + HOUR], olderCount: 4 };
  const atNoon = computeHistoryStats(history, midnight(0) + 12 * HOUR);
  assert.deepEqual(computeHistoryStats(history, midnight(0)), atNoon);
  assert.deepEqual(computeHistoryStats(history, midnight(-1) - 1), atNoon);
  assert.notDeepEqual(computeHistoryStats(history, midnight(-1)), atNoon, 'the next day moves the week on');
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
  assert.equal(stats.weeklyStudyRecallRate, 86);
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

test('the numbers next change with the clock when a reviewed card falls due, or at midnight if none does first', () => {
  const tonight = midnight(-1);
  assert.equal(nextStudyClockChange([], NOW), tonight);
  assert.equal(nextStudyClockChange([vocab('a', 'a', { reviews: 1, due: NOW + 2 * HOUR }), vocab('b', 'b', { reviews: 2, due: NOW + HOUR })], NOW), NOW + HOUR);
  // Cards already due, due after midnight, or never reviewed change nothing before midnight.
  const unchanged = [
    vocab('due', 'due', { reviews: 1, due: NOW - HOUR }),
    vocab('now', 'now', { reviews: 1, due: NOW }),
    vocab('later', 'later', { reviews: 1, due: tonight + HOUR }),
    vocab('new', 'new', { due: NOW + HOUR }),
  ];
  assert.equal(nextStudyClockChange(unchanged, NOW), tonight);
  assert.equal(nextStudyClockChange([{ ...vocab('bare', 'bare'), srs: undefined } as unknown as StoredItem], NOW), tonight);
  // Nor do Today's cards, which never reach Study.
  assert.equal(nextStudyClockChange([inLoop(vocab('p', 'p', { reviews: 1, due: NOW + HOUR }), 'practicing'), inLoop(vocab('s', 's', { reviews: 1, due: NOW + HOUR }), 'sayable')], NOW), tonight);
});

test('with nothing to review, the forecast says when the next card falls due and how many will be due by tomorrow', () => {
  const tonight = midnight(-1);
  const items = [
    vocab('a', 'run', { reviews: 2, due: NOW + 2 * HOUR + 10 * 60_000 }),
    vocab('b', 'Run', { reviews: 1, due: NOW + 3 * HOUR }), // the same spelling counts once
    vocab('c', 'walk', { reviews: 4, due: tonight }),
    vocab('d', 'jump', { reviews: 1, due: tonight + 1 }),
    vocab('e', 'fresh', { due: NOW + HOUR }), // never reviewed: new, not forecast
    { ...vocab('f', 'kept', { reviews: 1, due: NOW + HOUR }), isArchived: true },
    inLoop(vocab('g', 'practice', { reviews: 1, due: NOW + HOUR }), 'practicing'), // Today's: not forecast
    inLoop(vocab('h', 'say', { reviews: 2, due: NOW + HOUR }), 'sayable'),
  ];
  assert.deepEqual(studyForecast(items, NOW), { nextDueAt: NOW + 2 * HOUR + 10 * 60_000, dueByTomorrow: 2 });
  assert.deepEqual(studyForecast([vocab('d', 'jump', { reviews: 1, due: tonight + DAY })], NOW), { nextDueAt: tonight + DAY, dueByTomorrow: 0 });
  assert.equal(studyForecast([vocab('e', 'fresh')], NOW), null, 'nothing reviewed is scheduled');
  assert.equal(studyForecast([], NOW), null);
  assert.equal(studyForecast([inLoop(vocab('p', 'p', { reviews: 1, due: NOW + HOUR }), 'practicing')], NOW), null);
});

test('the Start caption says how many of the session\'s cards are due, and how many due wait after it', () => {
  const due = Array.from({ length: 40 }, (_, i) => vocab(`d${i}`, `due-${i}`, { reviews: 1, due: NOW - HOUR }));
  assert.equal(startCaption(due, 40), '40 due');
  assert.equal(startCaption(due, 110), '40 due · 70 more after this');
  assert.equal(startCaption(due.slice(0, 3), 3), '3 due');
});

test('classic Study takes cards reviewed before that are neither in Today\'s practice nor ones you can say', () => {
  assert.equal(isClassicStudyCard(vocab('r', 'r', { reviews: 2 })), true);
  assert.equal(isClassicStudyCard(vocab('n', 'n')), false, 'new cards enter through Today\'s sets');
  assert.equal(isClassicStudyCard(inLoop(vocab('p', 'p', { reviews: 1 }), 'practicing')), false);
  assert.equal(isClassicStudyCard(inLoop(vocab('s', 's', { reviews: 1 }), 'sayable')), false);
});

test('a countdown gives its two largest units, leaving out a part that is 0, and never less than a minute', () => {
  const MINUTE = 60_000;
  const cases: [ms: number, label: string][] = [
    [0, '1m'], [-5 * MINUTE, '1m'], [30_000, '1m'], [45 * MINUTE, '45m'], [44 * MINUTE + 1, '45m'], [59 * MINUTE + 1, '1h'],
    [2 * HOUR, '2h'], [2 * HOUR + 10 * MINUTE, '2h 10m'], [23 * HOUR + 59 * MINUTE, '23h 59m'],
    [DAY, '1d'], [3 * DAY + 4 * HOUR + 30 * MINUTE, '3d 4h'], [12 * DAY, '12d'],
  ];
  for (const [ms, label] of cases) assert.equal(formatCountdown(ms), label, String(ms));
});

test('recall counts only study-session grades: the popup\'s quick Got it, always Good, is no recall test', () => {
  const events = [
    review(NOW - HOUR, 'again', 'meaning'),
    review(NOW - HOUR, 'good', 'production'),
    review(NOW - 2 * HOUR, 'good', 'cloze'),
    review(NOW - 3 * HOUR, 'again', 'listening'),
    ...Array.from({ length: 6 }, () => review(NOW - 4 * HOUR, 'good', 'quick')),
  ];
  const stats = computeStudyStats([], recentOnly(events), NOW);
  assert.equal(stats.weeklyReviews, 10, 'every review still counts as a review');
  assert.equal(stats.weeklyStudyRecallRate, 50);
  // A review without a task type was never a study grade either.
  const unlabeled = { ...review(NOW - HOUR, 'again'), taskType: undefined };
  assert.equal(computeStudyStats([], recentOnly([unlabeled, review(NOW - HOUR, 'good', 'quick')]), NOW).weeklyStudyRecallRate, null);
  assert.equal(computeStudyStats([], recentOnly([]), NOW).weeklyStudyRecallRate, null);
});
