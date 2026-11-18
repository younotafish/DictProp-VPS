import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem } from '../../types.ts';
import AppNavigation from '../../components/AppNavigation.tsx';
import { practiceQueue } from '../../services/learningLoop/session.ts';
import { localDayStart } from '../../services/learningLoop/standing.ts';
import { nextPracticeClockChange } from '../../services/learningLoop/stats.ts';
import { practiceBadge } from '../../views/today/practiceBadge.ts';
import { DAY, HOUR, practicing, sayable, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

// The Today tab's badge counts with standing.ts alone, so the tab bar doesn't load the session model with the app's
// first screen. These tests hold its two numbers to the loop's own: practiceQueue's due count, which the plan offers,
// and nextPracticeClockChange, when the plan re-plans.

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const MIDNIGHT = localDayStart(NOW);
const YESTERDAY = MIDNIGHT - 12 * HOUR;

/** Every kind of item the rules tell apart: due, not yet due, reviewed today, out of the loop, not practicing. */
const LIBRARY: StoredItem[] = [
  vocabItem('due-a', 'alpha', { srs: practicing(NOW - 3 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW - HOUR }) }),
  vocabItem('due-b', 'beta', { srs: practicing(NOW - 5 * DAY, { lastReviewDate: NOW - 4 * DAY, nextReview: NOW - DAY }) }),
  sentenceItem('own', 'I keep an eye on it.', { srs: practicing(NOW - 3 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW - 2 * HOUR }) }),
  vocabItem('later', 'gamma', { srs: practicing(NOW - 2 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW + 2 * HOUR }) }),
  vocabItem('soon', 'delta', { srs: practicing(NOW - 2 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW + 5 * HOUR }) }),
  vocabItem('today', 'epsilon', { srs: practicing(NOW - 2 * DAY, { lastReviewDate: MIDNIGHT + HOUR, nextReview: NOW - HOUR }) }),
  vocabItem('joined-today', 'zeta', { srs: practicing(MIDNIGHT + 2 * HOUR, { nextReview: NOW + HOUR }) }),
  vocabItem('tomorrow', 'eta', { srs: practicing(NOW - 2 * DAY, { lastReviewDate: YESTERDAY, nextReview: localDayStart(NOW, 1) + HOUR }) }),
  vocabItem('can-say', 'theta', { srs: sayable(NOW - 3 * DAY, { nextReview: NOW - HOUR }) }),
  vocabItem('new', 'iota'),
  vocabItem('archived', 'kappa', { isArchived: true, srs: practicing(NOW - 3 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW - HOUR }) }),
  vocabItem('deleted', 'lambda', { isDeleted: true, srs: practicing(NOW - 3 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW + HOUR }) }),
  sentenceItem('untranslated', 'No translation yet.', { translation: null, srs: practicing(NOW - 3 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW - HOUR }) }),
  sentenceItem('catalog', 'A Real Life line.', { catalogKind: 'real-life', srs: practicing(NOW - 3 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW - HOUR }) }),
];

test('the badge counts what practiceQueue counts, and changes when nextPracticeClockChange says, at every moment of the day', () => {
  const moments = [
    NOW,
    NOW + 2 * HOUR, // 'later' falls due
    NOW + 6 * HOUR, // 'soon' too
    localDayStart(NOW, 1) + 30 * 60_000, // past midnight: the items reviewed today wait no longer
    localDayStart(NOW, 1) + 2 * HOUR, // 'tomorrow' falls due
  ];
  for (const now of moments) {
    const badge = practiceBadge(LIBRARY, now);
    assert.equal(badge.due, practiceQueue(LIBRARY, now).due, `due at ${new Date(now).toString()}`);
    assert.equal(badge.changesAt, nextPracticeClockChange(LIBRARY, now), `changes at ${new Date(now).toString()}`);
  }
  assert.deepEqual(practiceBadge(LIBRARY, NOW), { due: 3, changesAt: NOW + 2 * HOUR });
  assert.deepEqual(practiceBadge([], NOW), { due: 0, changesAt: localDayStart(NOW, 1) }, 'an empty library counts again at midnight');
});

test('the badge counts past the session cap: it says what is due, not what one session takes', () => {
  const many = Array.from({ length: 45 }, (_, index) =>
    vocabItem(`p${index}`, `word${index}`, { srs: practicing(NOW - 3 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW - index * 60_000 }) }));
  assert.equal(practiceBadge(many, NOW).due, 45);
  assert.equal(practiceQueue(many, NOW).due, 45);
});

const renderNav = (items: StoredItem[], sentenceDueCount = 0) => renderToStaticMarkup(createElement(AppNavigation, {
  currentView: 'study', onNavigate: () => {}, sentenceDueCount, items, onKeyboardHelp: () => {}, covered: false, onFocus: () => {},
}));

test('the Study tab is Today, with an orange badge of the practice due that a screen reader hears as to practice', t => {
  t.mock.method(Date, 'now', () => NOW);
  const markup = renderNav(LIBRARY, 4);
  assert.match(markup, /aria-label="Today, 3 to practice"/);
  assert.match(markup, /rounded-full bg-orange-500 px-1 text-\[9px\] font-bold leading-none text-white">3<\/span>/);
  assert.match(markup, />Today<\/span>/);
  assert.doesNotMatch(markup, />Study<\/span>/);
  // The Sentences badge keeps its violet and its words.
  assert.match(markup, /aria-label="Sentences, 4 to review"/);
  assert.match(markup, /rounded-full bg-violet-500 px-1 text-\[9px\] font-bold leading-none text-white">4<\/span>/);
});

test('with no practice due the Today tab has no badge, and past 99 it reads 99+', t => {
  t.mock.method(Date, 'now', () => NOW);
  const quiet = renderNav([vocabItem('new', 'iota')]);
  assert.doesNotMatch(quiet, /to practice/);
  assert.doesNotMatch(quiet, /bg-orange-500/);
  const lots = Array.from({ length: 120 }, (_, index) =>
    vocabItem(`p${index}`, `word${index}`, { srs: practicing(NOW - 3 * DAY, { lastReviewDate: YESTERDAY, nextReview: NOW - HOUR }) }));
  const busy = renderNav(lots);
  assert.match(busy, /aria-label="Today, 120 to practice"/);
  assert.match(busy, /bg-orange-500[^"]*">99\+<\/span>/);
});
