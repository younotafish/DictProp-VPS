import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewEvent, ReviewHistory, StoredItem } from '../../types.ts';
import { StudyDashboard } from '../../components/StudyDashboard.tsx';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Mid-afternoon local time, so "today" has room on both sides.
const NOW = new Date(2026, 10, 16, 15, 30).getTime();

function vocab(id: string, { reviews = 0, due = NOW + DAY, strength = 0, streak = 0 } = {}): StoredItem {
  return {
    type: 'vocab',
    data: {
      id, word: id, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
      history: '', register: '', mnemonic: '',
    },
    savedAt: 0,
    srs: {
      id, type: 'vocab', nextReview: due, interval: 0, memoryStrength: strength, lastReviewDate: reviews > 0 ? NOW - DAY : 0,
      totalReviews: reviews, correctStreak: streak, stability: 1,
    },
  };
}

const EMPTY_HISTORY: ReviewHistory = { recent: [], olderTimes: [], olderCount: 0 };

let nextEventId = 0;
const review = (reviewedAt: number, rating: ReviewEvent['rating'] = 'good', taskType: ReviewEvent['taskType'] = 'meaning'): ReviewEvent =>
  ({ id: String(nextEventId++), itemId: 'x', itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 1, rating, taskType });

/** The dashboard's markup, rendered as the server would, with the history given. Tests set the clock to NOW first. */
const render = (items: StoredItem[], reviewHistory: ReviewHistory & { loaded?: boolean } = EMPTY_HISTORY) =>
  renderToStaticMarkup(createElement(StudyDashboard, { items, reviewHistory, onStart: () => {} }));

const textOf = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

test('Most Practiced lists only reviewed cards, each once', t => {
  t.mock.method(Date, 'now', () => NOW);
  const markup = render([vocab('walk'), vocab('run', { reviews: 5 }), vocab('jump')]);
  assert.match(textOf(markup), /Most Practiced run \(5x\)$/);
  assert.doesNotMatch(markup, /\(0x\)/);
  assert.doesNotMatch(render([vocab('walk'), vocab('jump')]), /Most Practiced/);
});

test('the weekly reviews and the 7-day chart\'s total count the same reviews', t => {
  t.mock.method(Date, 'now', () => NOW);
  const history: ReviewHistory = {
    recent: [review(NOW - 8 * DAY), review(NOW - 6 * DAY - 23 * HOUR), review(NOW - 6 * DAY, 'again'), review(NOW - HOUR), review(NOW + DAY)],
    olderTimes: [],
    olderCount: 0,
  };
  const text = textOf(render([vocab('run', { reviews: 3 })], history));
  // 15:30 now: six days and 23 hours back is 16:30 seven days ago, before the chart's first day.
  assert.match(text, /Weekly Stats Last 7 days 2 Reviews/);
  assert.match(text, /Total: 2 reviews Avg: 0\/day/);
});

test('the dashboard counts what is due at the present time', t => {
  t.mock.method(Date, 'now', () => NOW);
  const items = [vocab('run', { reviews: 2, due: NOW - HOUR }), vocab('walk', { reviews: 1, due: NOW + HOUR }), vocab('jump', { reviews: 4, due: NOW })];
  assert.match(textOf(render(items)), /^Today's Study 2 Ready 2 Due/);
});

test('Start says how many due cards it reviews and how many due wait after the session; new cards wait for Today\'s sets', t => {
  t.mock.method(Date, 'now', () => NOW);
  const due = Array.from({ length: 110 }, (_, i) => vocab(`due-${i}`, { reviews: 1, due: NOW - HOUR }));
  const fresh = Array.from({ length: 12 }, (_, i) => vocab(`new-${i}`));
  const markup = render([...due, ...fresh]);
  assert.match(markup, /<button class="h-12 px-5 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed" aria-keyshortcuts="Enter">Review 40<\/button><p class="mt-1 text-xs text-slate-500">40 due · 70 more after this<\/p>/);
  assert.match(textOf(markup), /40 Ready 110 Due/);
  assert.match(render(fresh), /All caught up<\/button><\/div>/, 'only new cards: nothing for Study, and no forecast');
});

test('Today\'s practice and the cards you can say stay out of Study\'s Ready, Due and forecast', t => {
  t.mock.method(Date, 'now', () => NOW);
  const inLoop = (item: StoredItem, membership: object): StoredItem => ({ ...item, srs: { ...item.srs, ...membership, practiceChangedAt: NOW - DAY } });
  const items = [
    vocab('run', { reviews: 2, due: NOW - HOUR }),
    inLoop(vocab('walk', { reviews: 1, due: NOW - HOUR }), { practiceSince: NOW - DAY }),
    inLoop(vocab('jump', { reviews: 3, due: NOW - HOUR }), { sayableAt: NOW - DAY }),
  ];
  assert.match(textOf(render(items)), /^Today's Study 1 Ready 1 Due/);
  const later = [
    vocab('run', { reviews: 2, due: NOW + 3 * HOUR }),
    inLoop(vocab('walk', { reviews: 1, due: NOW + HOUR }), { practiceSince: NOW - DAY }),
  ];
  // The practicing card, due sooner, neither leads the countdown nor counts toward tomorrow's.
  assert.match(render(later), />Next card due in 3h · 1 by tomorrow<\/p>/);
});

test('with nothing to review, Start is a disabled All caught up captioned with when the next card falls due', t => {
  t.mock.method(Date, 'now', () => NOW);
  const tonight = new Date(2026, 10, 17).getTime();
  const items = [
    vocab('run', { reviews: 2, due: NOW + 2 * HOUR + 10 * 60_000 }),
    vocab('walk', { reviews: 1, due: NOW + 5 * HOUR }),
    vocab('jump', { reviews: 3, due: tonight + 9 * HOUR }),
  ];
  const markup = render(items);
  assert.match(markup, /<button disabled="" class="[^"]*">All caught up<\/button><p class="mt-1 text-xs text-slate-500">Next card due in 2h 10m · 2 by tomorrow<\/p>/);
  assert.doesNotMatch(markup, /aria-keyshortcuts="Enter"/);
  // Nothing due by tomorrow leaves the count out.
  assert.match(render([vocab('jump', { reviews: 3, due: tonight + 9 * HOUR })]), />Next card due in 17h 30m<\/p>/);
});

test('the dashboard says Recall (study) and Best card streak, captioned as the run a card holds now, and shows — for recall until a study grade is made', t => {
  t.mock.method(Date, 'now', () => NOW);
  const items = [vocab('run', { reviews: 3, streak: 4 })];
  const quickOnly: ReviewHistory = { recent: [review(NOW - HOUR, 'good', 'quick')], olderTimes: [], olderCount: 0 };
  const text = textOf(render(items, quickOnly));
  assert.match(text, /1 Reviews — Recall \(study\)/);
  assert.match(text, /Best card streak 4 correct in a row, now Total Reviews/);
  assert.doesNotMatch(text, /Recalled|Best Streak/);
  const studied: ReviewHistory = { recent: [review(NOW - HOUR, 'again'), review(NOW - HOUR, 'good'), review(NOW - HOUR, 'good', 'quick')], olderTimes: [], olderCount: 0 };
  assert.match(textOf(render(items, studied)), /3 Reviews 50% Recall \(study\)/);
});

test('until the history has loaded, every number drawn from it reads —, and the chart\'s bars are empty', t => {
  t.mock.method(Date, 'now', () => NOW);
  const items = [vocab('run', { reviews: 7, streak: 3, due: NOW - HOUR })];
  const outboxOnly = { recent: [review(NOW - HOUR, 'again')], olderTimes: [], olderCount: 0, loaded: false };
  const markup = render(items, outboxOnly);
  const text = textOf(markup);
  assert.match(text, /Weekly Stats Last 7 days — Reviews — Recall \(study\) — Day Streak/);
  assert.match(text, /Total: — reviews Avg: —\/day/);
  assert.match(text, /Total Reviews — all time/);
  const filledBar = /rounded-t transition-all duration-300 bg-(?:violet-500|indigo-400)/;
  assert.doesNotMatch(markup, filledBar, 'no bar is filled');
  assert.doesNotMatch(markup, /title="\d+ reviews"/);
  // The numbers counted from the items don't wait: the due count and the best card streak.
  assert.match(text, /1 Ready 1 Due/);
  assert.match(text, /Best card streak 3 correct in a row, now Total Reviews/);

  const loadedMarkup = render(items, { ...outboxOnly, loaded: true });
  assert.match(loadedMarkup, filledBar, "today's bar fills once the history has loaded");
  const loaded = textOf(loadedMarkup);
  assert.match(loaded, /Weekly Stats Last 7 days 1 Reviews 0% Recall \(study\) 1 Day Streak/);
  assert.match(loaded, /Total: 1 reviews Avg: 0\/day/);
  assert.match(loaded, /Total Reviews 7 all time/);
});
