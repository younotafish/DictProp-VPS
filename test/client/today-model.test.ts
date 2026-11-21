import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredItem } from '../../types.ts';
import { THEME_DOMAINS } from '../../server/src/shared/item-themes.ts';
import type { PlannedSet, ThemePlan } from '../../services/learningLoop/planner.ts';
import type { ActiveUnit } from '../../services/learningLoop/sessionStore.ts';
import { localDayStart } from '../../services/learningLoop/standing.ts';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats.ts';
import {
  UNSORTED,
  formatPlanDate,
  isUnfinished,
  planCardModel,
  sentenceCount,
  themeLabel,
  themesBrowserModel,
  todayHandlers,
  unitExclude,
  unitProgress,
  upNextUnits,
  type PlanCardInput,
  type UnitProgress,
} from '../../views/today/todayModel.ts';
import { DAY, HOUR, memorized, reviewed, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
// Two themes from different domains, read from the taxonomy so a renamed scene doesn't break the tests.
const FIRST = THEME_DOMAINS[0].themes[0];
const SECOND = THEME_DOMAINS[0].themes[1];
const OTHER = THEME_DOMAINS[2].themes[0];
const label = (theme: { emoji: string; title: string }) => ({ emoji: theme.emoji, title: theme.title });

/** A unit over `itemIds` from FIRST, started at `startedAt`. */
const unitOf = (itemIds: string[], startedAt = NOW - HOUR): ActiveUnit =>
  ({ version: 1, userId: 'user-1', id: 'unit-1', themeId: FIRST.id, itemIds, startedAt });

test('a theme is named by the taxonomy\'s emoji and title; none, or one this build doesn\'t know, is Unsorted', () => {
  assert.deepEqual(themeLabel(FIRST.id), label(FIRST));
  assert.deepEqual(themeLabel(null), UNSORTED);
  assert.deepEqual(themeLabel('retired-scene'), UNSORTED);
  assert.equal(UNSORTED.title, 'Unsorted');
});

test('Today listens for Enter on the plan and Esc in the themes browser, never over Card review or under the lesson', () => {
  assert.deepEqual(todayHandlers('plan', false), { keys: true, escape: false }, 'Esc on the plan is the app\'s');
  assert.deepEqual(todayHandlers('themes', false), { keys: false, escape: true });
  assert.deepEqual(todayHandlers('classic', false), { keys: false, escape: false }, 'Card review has classic Study\'s own');
  for (const screen of ['plan', 'themes', 'classic'] as const) {
    assert.deepEqual(todayHandlers(screen, true), { keys: false, escape: false }, `${screen} under the lesson or a card view`);
  }
});

test('the plan\'s date line names the weekday, the month and the day, and a count of sentences reads in the singular for one', () => {
  assert.equal(formatPlanDate(NOW), 'Wednesday, November 18');
  assert.deepEqual([0, 1, 2, 14].map(sentenceCount), ['0 sentences', '1 sentence', '2 sentences', '14 sentences']);
});

test('the active unit holds its live sentences in lesson order, counts the memorized, and opens at the first still to review', () => {
  const items: StoredItem[] = [
    sentenceItem('done-1', 'Got it in the unit.', { srs: memorized(NOW - HOUR) }),
    sentenceItem('fresh', 'Never reviewed.'),
    sentenceItem('due', 'Due again.', { srs: reviewed(NOW - 3 * DAY, { nextReview: NOW - HOUR }) }),
    sentenceItem('gone', 'Deleted since.', { isDeleted: true }),
    sentenceItem('kept', 'Archived since.', { isArchived: true }),
    sentenceItem('blank', ' '),
    vocabItem('word', 'not a sentence'),
    sentenceItem('done-2', 'Got it in the Sentences tab.', { srs: memorized(NOW - 2 * HOUR) }),
  ];
  const unit = unitOf(['done-2', 'gone', 'fresh', 'missing', 'kept', 'done-1', 'blank', 'word', 'due']);
  const progress = unitProgress(unit, items, NOW);
  assert.ok(progress);
  assert.equal(progress.unit, unit);
  assert.deepEqual(progress.items.map(item => item.data.id), ['done-2', 'fresh', 'done-1', 'due']);
  assert.equal(progress.items[1], items[1], 'the library\'s own copies');
  assert.equal(progress.memorized, 2);
  assert.equal(progress.next, 1, 'Continue opens at fresh, past the memorized done-2');
  assert.equal(isUnfinished(progress), true);

  // Every live sentence memorized: done. None live any more: absent.
  const done = unitProgress(unitOf(['done-1', 'gone', 'done-2']), items, NOW);
  assert.deepEqual([done?.items.length, done?.memorized, done?.next, isUnfinished(done!)], [2, 2, -1, false]);
  assert.equal(unitProgress(unitOf(['gone', 'kept', 'missing', 'word']), items, NOW), null);
  assert.equal(unitProgress(null, items, NOW), null);
  assert.equal(isUnfinished(null), false);
  // Two days on, a memorized sentence rests no longer, and the done unit is unfinished again.
  assert.equal(unitProgress(unitOf(['done-1', 'done-2']), items, NOW + 2 * DAY)?.next, 0);
});

test('the plan leaves the active unit\'s sentences out of every other unit while it is unfinished, and nothing once it is done', () => {
  const items: StoredItem[] = [
    sentenceItem('done', 'Got it in the unit.', { srs: memorized(NOW - HOUR) }),
    sentenceItem('fresh', 'Never reviewed.'),
    sentenceItem('gone', 'Deleted since.', { isDeleted: true }),
  ];
  // Unfinished, whatever day it started: all of its sentences, so no other unit takes the one still to review.
  const all = ['done', 'fresh', 'gone', 'missing'];
  assert.deepEqual(unitExclude(unitOf(all), items, NOW), new Set(all));
  assert.deepEqual(unitExclude(unitOf(['fresh'], localDayStart(NOW, -1) + HOUR), items, NOW), new Set(['fresh']), 'started yesterday');
  // Done, or with no live sentence left, or none at all: nothing is left out.
  assert.equal(unitExclude(unitOf(['done', 'gone']), items, NOW), undefined);
  assert.equal(unitExclude(unitOf(['gone', 'missing']), items, NOW), undefined);
  assert.equal(unitExclude(null, items, NOW), undefined);
  // Two days on, its memorized sentence is due again: the unit is unfinished, and keeps it from other units again.
  assert.deepEqual(unitExclude(unitOf(['done', 'gone']), items, NOW + 2 * DAY), new Set(['done', 'gone']));
});

const NEXT: PlannedSet = { themeId: SECOND.id, itemIds: Array.from({ length: DAILY_SET_GOAL }, (_, i) => `n${i}`) };
/** The active unit's progress: `size` sentences, `memorized` of them memorized, started `startedAt`. */
const progressOf = (size: number, memorizedCount: number, startedAt = NOW - HOUR): UnitProgress => {
  const items = Array.from({ length: size }, (_, i) =>
    sentenceItem(`u${i}`, `Unit line ${i}.`, i < memorizedCount ? { srs: memorized(NOW - HOUR) } : {}));
  return unitProgress(unitOf(items.map(item => item.data.id), startedAt), items, NOW)!;
};
const card = (input: Partial<PlanCardInput> = {}) => planCardModel({
  unit: null, todayCount: 0, historyLoaded: true, next: NEXT, themes: 'ready', sortingPercent: null, now: NOW, ...input,
});

test('an unfinished unit is offered as Continue, whatever day it started, the goal met or not', () => {
  const continuing = { kind: 'continue', theme: label(FIRST), size: 14, memorized: 5 };
  assert.deepEqual(card({ unit: progressOf(14, 5) }), continuing);
  assert.deepEqual(card({ unit: progressOf(14, 5, localDayStart(NOW, -1) + HOUR) }), continuing, 'started yesterday');
  assert.deepEqual(card({ unit: progressOf(14, 5), todayCount: DAILY_SET_GOAL + 2 }), continuing, 'the goal met');
  assert.deepEqual(card({ unit: progressOf(14, 0), next: null, themes: 'offline' }), { ...continuing, memorized: 0 });
});

test('without an unfinished unit, Start unit offers the plan\'s next unit until the goal is met', () => {
  const start = { kind: 'start', set: NEXT, theme: label(SECOND), size: DAILY_SET_GOAL };
  assert.deepEqual(card(), start);
  assert.deepEqual(card({ todayCount: DAILY_SET_GOAL - 1 }), start, 'one short of the goal');
  assert.deepEqual(card({ todayCount: DAILY_SET_GOAL, historyLoaded: false }), start, 'met only once the history is in');
  assert.deepEqual(card({ unit: progressOf(12, 12) }), start, 'a unit done today, the goal not met: Got its outside the unit');
  assert.deepEqual(card({ next: { themeId: null, itemIds: ['x'] } }), { kind: 'start', set: { themeId: null, itemIds: ['x'] }, theme: UNSORTED, size: 1 });
  assert.deepEqual(card({ themes: 'loading' }), start, 'a kept theme map plans while the server answers');
});

test('once the goal is met it is Done for today, naming a unit done today and offering another unit when there is one', () => {
  assert.deepEqual(card({ todayCount: DAILY_SET_GOAL, unit: progressOf(14, 14) }), {
    kind: 'done', finished: { theme: label(FIRST), memorized: 14 }, another: { set: NEXT, theme: label(SECOND) },
  });
  // A done unit shows only on the local day it started; one from yesterday is passed over.
  const yesterday = progressOf(14, 14, localDayStart(NOW, -1) + 23 * HOUR);
  assert.deepEqual(card({ todayCount: DAILY_SET_GOAL + 3, unit: yesterday }), {
    kind: 'done', finished: null, another: { set: NEXT, theme: label(SECOND) },
  });
  assert.deepEqual(card({ todayCount: DAILY_SET_GOAL }), { kind: 'done', finished: null, another: { set: NEXT, theme: label(SECOND) } });
  assert.deepEqual(card({ todayCount: DAILY_SET_GOAL, next: null, unit: progressOf(12, 12) }), {
    kind: 'done', finished: { theme: label(FIRST), memorized: 12 }, another: null,
  }, 'no unit left to offer');
});

test('with no unit to offer the card says why: the themes loading, out of reach, being sorted, or nothing to review', () => {
  assert.deepEqual(card({ next: null, themes: 'loading' }), { kind: 'loading' });
  assert.deepEqual(card({ next: null, themes: 'offline' }), { kind: 'offline' });
  assert.deepEqual(card({ next: null, sortingPercent: 42 }), { kind: 'sorting', percent: 42 });
  assert.deepEqual(card({ next: null }), { kind: 'empty' });
  assert.deepEqual(card({ next: null, unit: progressOf(12, 12), historyLoaded: false, todayCount: DAILY_SET_GOAL }), { kind: 'empty' });
});

test('up next lists three units after the one the card offers: with Continue on the card, the plan\'s next unit first', () => {
  const set = (id: string): PlannedSet => ({ themeId: OTHER.id, itemIds: [id] });
  const plan = { today: set('t'), upNext: [set('a'), set('b'), set('c')] };
  const ids = (rows: ReturnType<typeof upNextUnits>) => rows.map(row => row.set.itemIds[0]);
  assert.deepEqual(ids(upNextUnits(card({ unit: progressOf(14, 5) }), plan)), ['t', 'a', 'b']);
  assert.deepEqual(ids(upNextUnits(card({ next: plan.today }), plan)), ['a', 'b', 'c'], 'Start unit offers t itself');
  assert.deepEqual(ids(upNextUnits(card({ next: plan.today, todayCount: DAILY_SET_GOAL }), plan)), ['a', 'b', 'c'], 'and so does Another unit');
  assert.deepEqual(upNextUnits(card({ unit: progressOf(14, 5) }), plan)[0].theme, label(OTHER));
  assert.deepEqual(upNextUnits(card({ unit: progressOf(14, 5), next: null }), { today: null, upNext: [] }), []);
});

const themePlan = (themeId: string | null, fields: Partial<ThemePlan> = {}): ThemePlan => ({
  themeId, toReviewCount: 0, memorizedCount: 0, total: 0, recentCount: 0, nextSet: [], ...fields,
});

test('the themes browser lists the domains and themes that hold sentences in the taxonomy\'s order, then Unsorted', () => {
  const plan = {
    themes: new Map([
      [OTHER.id, themePlan(OTHER.id, { toReviewCount: 2, memorizedCount: 3, total: 5, nextSet: ['o1', 'o2'] })],
      [SECOND.id, themePlan(SECOND.id, { memorizedCount: 4, total: 4 })],
      [FIRST.id, themePlan(FIRST.id, { toReviewCount: 30, memorizedCount: 1, total: 31, nextSet: ['f1'] })],
    ]),
    unsorted: themePlan(null, { toReviewCount: 1, total: 1, nextSet: ['u1'] }),
  };
  const model = themesBrowserModel(plan);
  assert.deepEqual(model.domains.map(domain => domain.id), [THEME_DOMAINS[0].id, THEME_DOMAINS[2].id]);
  assert.deepEqual(model.domains[0].themes.map(row => row.themeId), [FIRST.id, SECOND.id]);
  assert.deepEqual(model.domains[0].themes[0], {
    themeId: FIRST.id, theme: label(FIRST), toReviewCount: 30, memorizedCount: 1, total: 31, set: { themeId: FIRST.id, itemIds: ['f1'] },
    continues: false,
  });
  assert.equal(model.domains[0].themes[1].set, null, 'nothing to review: nothing to start');
  assert.equal(model.domains[0].themes[1].continues, false, 'nor anything to continue');
  assert.deepEqual(model.unsorted?.set, { themeId: null, itemIds: ['u1'] });
  assert.deepEqual(model.unsorted?.theme, UNSORTED);
  assert.equal(themesBrowserModel({ themes: new Map(), unsorted: themePlan(null) }).unsorted, null);
  assert.deepEqual(themesBrowserModel({ themes: new Map(), unsorted: themePlan(null) }).domains, []);
});

test('a theme whose sentences to review are all in the unfinished unit continues it rather than starting another', () => {
  const plan = {
    themes: new Map([[FIRST.id, themePlan(FIRST.id, { toReviewCount: 10, memorizedCount: 5, total: 15 })]]),
    unsorted: themePlan(null, { toReviewCount: 3, total: 3 }),
  };
  const model = themesBrowserModel(plan);
  assert.equal(model.domains[0].themes[0].set, null);
  assert.equal(model.domains[0].themes[0].continues, true);
  assert.equal(model.unsorted?.continues, true, 'a unit from Unsorted too');
});
