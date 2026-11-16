import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SRSData } from '../../types.ts';
import { SrsStats } from '../../components/review/SrsStats.tsx';
import { getMasteryColors } from '../../components/mastery.tsx';
import { formatReviewInterval, formatTimeUntil, reviewIntervalDays } from '../../services/reviewTime.ts';
import * as studySession from '../../services/studySession.ts';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('the next review reads in whole days, hours or minutes, and as now once it is due', () => {
  assert.equal(formatTimeUntil(NOW - 1, NOW), 'now');
  assert.equal(formatTimeUntil(NOW, NOW), 'now');
  assert.equal(formatTimeUntil(NOW + MINUTE - 1, NOW), 'now');
  assert.equal(formatTimeUntil(NOW + MINUTE, NOW), '1m');
  assert.equal(formatTimeUntil(NOW + HOUR - 1, NOW), '59m');
  assert.equal(formatTimeUntil(NOW + HOUR, NOW), '1h');
  assert.equal(formatTimeUntil(NOW + DAY - 1, NOW), '23h');
  assert.equal(formatTimeUntil(NOW + 3 * DAY + 5 * HOUR, NOW), '3d');
});

test('a schedule\'s interval is its whole days from now, rounded, and never under a day', () => {
  assert.equal(reviewIntervalDays(NOW + 3 * DAY, NOW), 3);
  assert.equal(reviewIntervalDays(NOW + 3 * DAY + 11 * HOUR, NOW), 3);
  assert.equal(reviewIntervalDays(NOW + 3 * DAY + 12 * HOUR, NOW), 4);
  assert.equal(reviewIntervalDays(NOW + 10 * MINUTE, NOW), 1);
  assert.equal(reviewIntervalDays(NOW, NOW), 1);
  assert.equal(reviewIntervalDays(NOW - DAY, NOW), 1);
  assert.equal(reviewIntervalDays(NOW + 120 * DAY, NOW), 120);
});

test('the study session still hands out the review-time labels it used to hold', () => {
  assert.equal(studySession.formatTimeUntil, formatTimeUntil);
  assert.equal(studySession.formatReviewInterval, formatReviewInterval);
});

const srs = (fields: Partial<SRSData>): SRSData => ({
  id: 'w1', type: 'vocab', nextReview: NOW + 3 * DAY, interval: 3, memoryStrength: 40, lastReviewDate: NOW - DAY,
  totalReviews: 7, correctStreak: 3, stability: 3, ...fields,
});
const learning = { label: 'Learning', color: 'amber', percentage: 44.6 };
const render = (props: Parameters<typeof SrsStats>[0]) => renderToStaticMarkup(createElement(SrsStats, props));

test('the compact row keeps every stat on one line and leaves the bar out on phones', t => {
  t.mock.method(Date, 'now', () => NOW);
  const markup = render({ srs: srs({}), mastery: learning, colors: getMasteryColors('amber'), compact: true });
  assert.equal(
    markup,
    '<span class="bg-amber-100 text-amber-600 px-2 py-0.5 rounded-full font-semibold whitespace-nowrap">Learning 45%</span>'
    + '<div class="hidden sm:block flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden"><div class="h-full bg-amber-400 transition-all duration-300" style="width:44.6%"></div></div>'
    + '<span class="text-slate-400 whitespace-nowrap">7×</span>'
    + '<span class="text-orange-500 flex items-center gap-0.5">'
    + markup.match(/<svg[^]*?<\/svg>/)?.[0]
    + '3</span>'
    + '<span class="text-slate-500 whitespace-nowrap">3d</span>',
  );
});

test('the full row lets its badge and next review wrap, shows the bar everywhere, and puts its extras before the next review', t => {
  t.mock.method(Date, 'now', () => NOW);
  const markup = render({
    srs: srs({ correctStreak: 0, nextReview: NOW - 1 }), mastery: learning, colors: getMasteryColors('amber'),
    children: createElement('span', { className: 'extra' }, '•'),
  });
  assert.match(markup, /^<span class="bg-amber-100 text-amber-600 px-2 py-0\.5 rounded-full font-semibold">Learning/);
  assert.match(markup, /<div class="flex-1 h-1\.5 bg-slate-200 rounded-full overflow-hidden">/);
  assert.doesNotMatch(markup, /text-orange-500/);
  assert.match(markup, /<span class="extra">•<\/span><span class="text-slate-500">due<\/span>$/);
});

test('without a schedule the row reads no reviews and due', t => {
  t.mock.method(Date, 'now', () => NOW);
  const markup = render({ srs: undefined, mastery: { label: 'New', color: 'slate', percentage: 0 }, colors: getMasteryColors('slate'), compact: true });
  assert.match(markup, /<span class="text-slate-400 whitespace-nowrap">0×<\/span><span class="text-slate-500 whitespace-nowrap">due<\/span>$/);
});
