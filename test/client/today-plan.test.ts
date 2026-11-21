import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { THEME_DOMAINS } from '../../server/src/shared/item-themes.ts';
import type { PlannedSet } from '../../services/learningLoop/planner.ts';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats.ts';
import { ThemesBrowser } from '../../views/today/ThemesBrowser.tsx';
import { TodayPlan, type TodayPlanProps } from '../../views/today/TodayPlan.tsx';
import { UNSORTED, type PlanCardModel, type ThemeRow } from '../../views/today/todayModel.ts';

// The plan and the themes browser as they render, in each state of the unit card.

const NOW = new Date(2026, 10, 18, 15, 0).getTime();
const FIRST = THEME_DOMAINS[0].themes[0];
const SECOND = THEME_DOMAINS[1].themes[0];
const THIRD = THEME_DOMAINS[2].themes[0];
const label = (theme: { emoji: string; title: string }) => ({ emoji: theme.emoji, title: theme.title });

const textOf = (markup: string) => markup
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#x27;/g, '\'')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();
const noop = () => {};

const NEXT: PlannedSet = { themeId: FIRST.id, itemIds: Array.from({ length: DAILY_SET_GOAL }, (_, i) => `n${i}`) };
const START: PlanCardModel = { kind: 'start', set: NEXT, theme: label(FIRST), size: DAILY_SET_GOAL };
const CONTINUE: PlanCardModel = { kind: 'continue', theme: label(FIRST), size: 14, memorized: 5 };

function renderPlan(props: Partial<TodayPlanProps> = {}) {
  return renderToStaticMarkup(createElement(TodayPlan, {
    now: NOW, card: START, todayCount: 3, streak: 4, upNext: [], hasThemes: true, sorting: null, classicDue: 8,
    classicResumable: false, onContinue: noop, onStartUnit: noop, onThemes: noop, onClassic: noop, ...props,
  }));
}

/** The unit card's section, from its opening tag to its close. */
const cardOf = (markup: string) => markup.match(/<section aria-label="Today’s unit"[\s\S]*?<\/section>/)![0];

test('the plan\'s header has the date, the streak and the goal ring out of the day\'s goal', () => {
  const markup = renderPlan();
  assert.match(markup, /<h2 class="text-3xl font-bold text-slate-800">Today<\/h2><p class="mt-0.5 text-sm text-slate-500">Wednesday, November 18<\/p>/);
  assert.match(markup, /aria-label="4-day streak"/);
  assert.match(markup, new RegExp(`aria-label="Today’s goal: 3 of ${DAILY_SET_GOAL} sentences reviewed"`));
  assert.match(markup, new RegExp(`>3/${DAILY_SET_GOAL}</span>`));
  // Before the history loads, both read '—'.
  const loading = renderPlan({ todayCount: null, streak: null });
  assert.match(loading, /aria-label="Streak: loading"/);
  assert.match(loading, /aria-label="Today’s goal: loading"/);
  assert.match(loading, new RegExp(`>—/${DAILY_SET_GOAL}</span>`));
  // A streak of 0 is a grey flame.
  assert.match(renderPlan({ streak: 0 }), /text-slate-300"[^>]*>.*?<\/svg><span[^>]*>0<\/span>/);
});

test('an unfinished unit shows its theme, how many of its sentences are memorized and a bar of them, and Continue on Enter', () => {
  const section = cardOf(renderPlan({ card: CONTINUE }));
  assert.equal(textOf(section), `Unit ${FIRST.emoji} ${FIRST.title} 14 sentences · 5 memorized Continue`);
  assert.match(section, new RegExp(`role="progressbar" aria-label="${FIRST.title}: 5 of 14 memorized" aria-valuemin="0" aria-valuemax="100" aria-valuenow="36"`));
  assert.match(section, /<span class="block h-full rounded-full bg-emerald-500" style="width:36%"><\/span>/);
  assert.match(section, /<button type="button" aria-keyshortcuts="Enter" class="[^"]*bg-indigo-600[^"]*">Continue<\/button>/);
});

test('a unit to start shows its theme and size, and Start unit on Enter', () => {
  const section = cardOf(renderPlan());
  assert.equal(textOf(section), `Unit ${FIRST.emoji} ${FIRST.title} ${DAILY_SET_GOAL} sentences Start unit`);
  assert.match(section, /<button type="button" aria-keyshortcuts="Enter" class="[^"]*bg-indigo-600[^"]*">Start unit<\/button>/);
  assert.doesNotMatch(section, /memorized|progressbar/);
  const unsorted = cardOf(renderPlan({ card: { kind: 'start', set: { themeId: null, itemIds: ['u'] }, theme: UNSORTED, size: 1 } }));
  assert.equal(textOf(unsorted), `Unit ${UNSORTED.emoji} Unsorted 1 sentence Start unit`);
});

test('once the goal is met the card says Done for today, names a unit done today, and offers another unit, none on Enter', () => {
  const done: PlanCardModel = {
    kind: 'done', finished: { theme: label(FIRST), memorized: 14 }, another: { set: { themeId: SECOND.id, itemIds: ['x'] }, theme: label(SECOND) },
  };
  const section = cardOf(renderPlan({ card: done, todayCount: 14 }));
  assert.equal(textOf(section), `Done for today ✓ ✓ ${FIRST.emoji} ${FIRST.title} · 14 memorized Another unit: ${SECOND.emoji} ${SECOND.title}`);
  assert.match(section, /<p role="status"[^>]*>Done for today ✓<\/p>/);
  assert.doesNotMatch(section, /aria-keyshortcuts/, 'nothing for Enter to press');
  assert.equal(textOf(cardOf(renderPlan({ card: { kind: 'done', finished: null, another: null } }))), 'Done for today ✓');
});

test('with no unit to offer the card says why: sorting, loading, offline on a first run, or nothing to review', () => {
  const sorting = renderPlan({ card: { kind: 'sorting', percent: 42 }, sorting: { percent: 42 } });
  assert.match(textOf(cardOf(sorting)), /Sorting your sentences into themes… 42%/);
  assert.equal(textOf(sorting).match(/Sorting your sentences/g)?.length, 1, 'said once, in the card');
  assert.equal(textOf(cardOf(renderPlan({ card: { kind: 'loading' } }))), 'Loading themes…');
  assert.equal(textOf(cardOf(renderPlan({ card: { kind: 'offline' } }))), 'Themes load when you’re online.');
  assert.equal(textOf(cardOf(renderPlan({ card: { kind: 'empty' } }))), '✓ Nothing to review in your themes');
  for (const kind of ['loading', 'offline', 'empty'] as const) {
    assert.doesNotMatch(renderPlan({ card: { kind } }), /Start unit|Continue|Done for today|aria-keyshortcuts/, kind);
  }
});

test('while the server still sorts but a unit is ready, the sorting shows under the card, with its error', () => {
  const text = textOf(renderPlan({ sorting: { percent: 70, error: 'The classifier is out of credit.' } }));
  assert.match(text, /Start unit Sorting your sentences into themes… 70% The classifier is out of credit\./);
});

test('up next lists the following units, each a button, with All themes beside its heading', () => {
  const upNext = [
    { set: { themeId: SECOND.id, itemIds: ['x', 'y'] }, theme: label(SECOND) },
    { set: { themeId: SECOND.id, itemIds: ['w'] }, theme: label(SECOND) },
    { set: { themeId: null, itemIds: ['z'] }, theme: UNSORTED },
  ];
  const markup = renderPlan({ upNext });
  assert.match(markup, new RegExp(`aria-label="Start unit: ${SECOND.title}, 2 sentences"`));
  assert.match(markup, new RegExp(`aria-label="Start unit: ${SECOND.title}, 1 sentence"`), 'a theme can come round twice');
  assert.match(markup, /aria-label="Start unit: Unsorted, 1 sentence"/);
  assert.match(textOf(markup), new RegExp(`Up next All themes › ${SECOND.emoji} ${SECOND.title} 2 › ${SECOND.emoji} ${SECOND.title} 1 › ${UNSORTED.emoji} Unsorted 1 ›`));
  assert.match(textOf(renderPlan({ upNext: [] })), /Up next All themes ›/, 'the themes browser without a unit up next');
  assert.doesNotMatch(renderPlan({ upNext: [], hasThemes: false }), /Up next/);
});

type ElementLike = { type?: unknown; props?: Record<string, unknown> };

/** The plan's element tree with its own parts drawn out, none of which has hooks, so a test can press its buttons. */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object') return node;
  const element = node as ElementLike;
  if (typeof element.type === 'function') return expand((element.type as (props: unknown) => unknown)(element.props));
  return element.props ? { ...element, props: { ...element.props, children: expand(element.props.children) } } : node;
}

/** The words an element's tree holds, a space between its parts, as a reader sees them. */
const wordsIn = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(wordsIn).join(' ');
  return node && typeof node === 'object' ? wordsIn((node as ElementLike).props?.children) : '';
};

/** Every button in the plan as drawn with `props`: what it says, and its press. */
function buttonsOf(props: Partial<TodayPlanProps>): Map<string, () => void> {
  const buttons = new Map<string, () => void>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const element = node as ElementLike;
    if (element.type === 'button') {
      const name = String(element.props?.['aria-label'] ?? wordsIn(element)).replace(/\s+/g, ' ').trim();
      buttons.set(name, element.props?.onClick as () => void);
    }
    visit(element.props?.children);
  };
  visit(expand(TodayPlan({
    now: NOW, card: START, todayCount: 3, streak: 4, upNext: [], hasThemes: true, sorting: null, classicDue: 8,
    classicResumable: false, onContinue: noop, onStartUnit: noop, onThemes: noop, onClassic: noop, ...props,
  })));
  return buttons;
}

test('each button of the plan does what it says: Start unit and Another unit start their unit, Continue continues', () => {
  const pressed: string[] = [];
  const handlers: Partial<TodayPlanProps> = {
    onContinue: () => pressed.push('continue'),
    onStartUnit: set => pressed.push(`start ${set.itemIds.join(',')}`),
    onThemes: () => pressed.push('themes'),
    onClassic: () => pressed.push('classic'),
    upNext: [{ set: { themeId: SECOND.id, itemIds: ['x', 'y'] }, theme: label(SECOND) }],
  };
  const starting = buttonsOf({ ...handlers, card: { ...START, set: { themeId: FIRST.id, itemIds: ['n0', 'n1'] } } });
  starting.get('Start unit')!();
  starting.get(`Start unit: ${SECOND.title}, 2 sentences`)!();
  starting.get('All themes ›')!();
  starting.get('Card review 8 due ›')!();
  buttonsOf({ ...handlers, card: CONTINUE }).get('Continue')!();
  const another = { set: { themeId: THIRD.id, itemIds: ['t'] }, theme: label(THIRD) };
  buttonsOf({ ...handlers, card: { kind: 'done', finished: null, another } }).get(`Another unit: ${THIRD.emoji} ${THIRD.title}`)!();
  assert.deepEqual(pressed, ['start n0,n1', 'start x,y', 'themes', 'classic', 'continue', 'start t']);
  assert.deepEqual([...buttonsOf({ card: CONTINUE }).keys()], ['Continue', 'All themes ›', 'Card review 8 due ›'], 'no Start unit beside Continue');
});

test('Card review ends the plan, with classic Study\'s due count or Resume', () => {
  assert.match(textOf(renderPlan()), /Card review 8 due ›$/);
  assert.match(textOf(renderPlan({ classicResumable: true })), /Card review Resume ›$/);
});

test('the plan holds the unit card, Up next and Card review, and nothing of v3\'s loop', () => {
  for (const card of [START, CONTINUE]) {
    const text = textOf(renderPlan({ card, upNext: [{ set: NEXT, theme: label(FIRST) }] }));
    assert.doesNotMatch(text, /Progress|Can say|Practic|Passive|Speak|Quiet|Tomorrow|This week|translat|Set\b|Start set/, text);
  }
  assert.doesNotMatch(renderPlan(), /radiogroup/, 'no mode switch');
});

const row = (fields: Partial<ThemeRow> & Pick<ThemeRow, 'themeId' | 'theme'>): ThemeRow => ({
  toReviewCount: 0, memorizedCount: 0, total: 0, set: null, ...fields,
});

test('the themes browser groups themes under their domains, Unsorted last without a heading; a theme to review starts a unit', () => {
  const domains = [
    { id: THEME_DOMAINS[0].id, title: THEME_DOMAINS[0].title, emoji: THEME_DOMAINS[0].emoji, themes: [
      row({ themeId: FIRST.id, theme: label(FIRST), toReviewCount: 30, memorizedCount: 6, total: 36, set: { themeId: FIRST.id, itemIds: ['a', 'b'] } }),
    ] },
    { id: THEME_DOMAINS[2].id, title: THEME_DOMAINS[2].title, emoji: THEME_DOMAINS[2].emoji, themes: [
      row({ themeId: THIRD.id, theme: label(THIRD), memorizedCount: 4, total: 4 }),
    ] },
  ];
  const unsorted = row({ themeId: null, theme: UNSORTED, toReviewCount: 2, total: 2, set: { themeId: null, itemIds: ['u1', 'u2'] } });
  const markup = renderToStaticMarkup(createElement(ThemesBrowser, { model: { domains, unsorted }, onBack: noop, onStart: noop }));
  const text = textOf(markup);
  assert.match(text, new RegExp(`^All themes ${THEME_DOMAINS[0].emoji} ${THEME_DOMAINS[0].title} ${FIRST.emoji} ${FIRST.title} 30 to review · 6 memorized ›`));
  assert.ok(text.includes(`${THEME_DOMAINS[2].emoji} ${THEME_DOMAINS[2].title} ${THIRD.emoji} ${THIRD.title} 0 to review · 4 memorized 🗂️ Unsorted`));
  assert.match(text, /🗂️ Unsorted 2 to review · 0 memorized ›$/);
  assert.match(markup, new RegExp(`aria-label="Start a unit from ${FIRST.title}: 2 of 30 to review"`));
  assert.match(markup, new RegExp(`aria-label="${FIRST.title}: 6 of 36 memorized" aria-valuemin="0" aria-valuemax="100" aria-valuenow="17"`));
  assert.match(markup, new RegExp(`aria-label="${THIRD.title}: 4 of 4 memorized" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"`));
  assert.doesNotMatch(markup, new RegExp(`Start a unit from ${THIRD.title}`), 'nothing to review, nothing to start');
  assert.match(markup, /<section class="mt-6 first:mt-0" aria-label="Unsorted"><ul/, 'Unsorted has no heading');
  assert.match(markup, /aria-label="Back to Today"/);
  assert.doesNotMatch(text, /new|practicing|can say/);

  const empty = renderToStaticMarkup(createElement(ThemesBrowser, { model: { domains: [], unsorted: null }, onBack: noop, onStart: noop }));
  assert.match(textOf(empty), /No themes yet: they appear as your sentences are sorted\./);
});
