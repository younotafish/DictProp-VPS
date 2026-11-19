import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { THEME_DOMAINS } from '../../server/src/shared/item-themes.ts';
import type { PlannedSet } from '../../services/learningLoop/planner.ts';
import { PRACTICE_SESSION_CAP } from '../../services/learningLoop/session.ts';
import { DAILY_SET_GOAL, PRACTICE_FIRST_AT, type LoopProgress } from '../../services/learningLoop/stats.ts';
import { LoopSummary, type LoopSummaryProps } from '../../views/today/LoopSummary.tsx';
import { ThemesBrowser } from '../../views/today/ThemesBrowser.tsx';
import { TodayPlan, type TodayPlanProps } from '../../views/today/TodayPlan.tsx';
import { UNSORTED, planCardModel, summaryActions, type PlanCardInput, type ThemeRow } from '../../views/today/todayModel.ts';

// The plan, the themes browser and a session's summary as they render, in each state DESIGN-v2 §6 and §8 name.

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
const PROGRESS: LoopProgress = { sayable: 41, sayableThisWeek: 6, practicing: 23, practiceDue: 0, tomorrow: 9, savedThisWeek: 17 };

/** The plan with the card the host would compute for `card`, and anything else replaced. */
function renderPlan(card: Partial<PlanCardInput> = {}, props: Partial<TodayPlanProps> = {}) {
  const next = card.next === undefined ? NEXT : card.next;
  const model = planCardModel({
    progress: { practiceDue: 0, practicing: PROGRESS.practicing }, todayCount: 3, historyLoaded: true, themes: 'ready',
    sortingPercent: null, ...card, next,
  });
  return renderToStaticMarkup(createElement(TodayPlan, {
    now: NOW, card: model, next, mode: 'speak', onModeChange: noop, todayCount: 3, streak: 4, upNext: [], hasThemes: true,
    progress: PROGRESS, sortedThisWeek: 12, sorting: null, classicDue: 8, classicResumable: false, resumeLabel: null,
    onPractice: noop, onStartSet: noop, onResume: noop, onThemes: noop, onClassic: noop, ...props,
  }));
}

test('the plan\'s header has the date, the streak and the goal ring out of the day\'s goal', () => {
  const markup = renderPlan();
  assert.match(markup, /<h2 class="text-3xl font-bold text-slate-800">Today<\/h2><p class="mt-0.5 text-sm text-slate-500">Wednesday, November 18<\/p>/);
  assert.match(markup, /aria-label="4-day streak"/);
  assert.match(markup, new RegExp(`aria-label="Today’s goal: 3 of ${DAILY_SET_GOAL} new sentences met"`));
  assert.match(renderPlan({}, { todayCount: 1 }), new RegExp(`aria-label="Today’s goal: 1 of ${DAILY_SET_GOAL} new sentences met"`));
  assert.match(markup, new RegExp(`>3/${DAILY_SET_GOAL}</span>`));
  // Before the history loads, both read '—'.
  const loading = renderPlan({}, { todayCount: null, streak: null });
  assert.match(loading, /aria-label="Streak: loading"/);
  assert.match(loading, /aria-label="Today’s goal: loading"/);
  assert.match(loading, new RegExp(`>—/${DAILY_SET_GOAL}</span>`));
  // A streak of 0 is a grey flame.
  assert.match(renderPlan({}, { streak: 0 }), /text-slate-300"[^>]*>.*?<\/svg><span[^>]*>0<\/span>/);
});

test('with practice due the card offers Practice, at most a session\'s worth', () => {
  const text = textOf(renderPlan({ progress: { practiceDue: 7, practicing: 23 } }));
  assert.match(text, new RegExp(`Practice · 7 due ${FIRST.emoji} Set · ${FIRST.title} · ${DAILY_SET_GOAL} Practice 7 Speak Quiet`));
  const many = renderPlan({ progress: { practiceDue: 52, practicing: 80 } });
  assert.match(many, new RegExp(`aria-keyshortcuts="Enter"[^>]*>Practice ${PRACTICE_SESSION_CAP}</button>`));
});

test('past the practice-first line the set row says practice comes first', () => {
  const text = textOf(renderPlan({ progress: { practiceDue: PRACTICE_FIRST_AT + 6, practicing: 90 } }));
  assert.match(text, new RegExp(`Practice · ${PRACTICE_FIRST_AT + 6} due Practice first · ${PRACTICE_FIRST_AT + 6} due Practice ${PRACTICE_SESSION_CAP}`));
});

test('with nothing due the card names the set and Start set starts it; the practice row says Practiced or that nothing is in practice', () => {
  const markup = renderPlan();
  assert.match(textOf(markup), new RegExp(`✓ Practiced ${FIRST.emoji} Set · ${FIRST.title} · ${DAILY_SET_GOAL} Start set`));
  assert.match(markup, /aria-keyshortcuts="Enter"[^>]*>Start set<\/button>/);
  assert.match(textOf(renderPlan({ progress: { practiceDue: 0, practicing: 0 } })), new RegExp(`Nothing to practice yet ${FIRST.emoji} Set ·`));
});

test('once the goal is met it is Done for today, with Another set on offer', () => {
  const markup = renderPlan({ todayCount: DAILY_SET_GOAL }, { todayCount: DAILY_SET_GOAL });
  assert.match(textOf(markup), new RegExp(`✓ ${DAILY_SET_GOAL} today Done for today ✓ Another set: ${FIRST.emoji} ${FIRST.title}`));
  assert.match(markup, /<p role="status"[^>]*>Done for today ✓<\/p>/);
  assert.doesNotMatch(markup, /aria-keyshortcuts="Enter"/, 'nothing for Enter to press');
  assert.doesNotMatch(textOf(renderPlan({ todayCount: DAILY_SET_GOAL, next: null })), /Another set/);
});

test('without a set the row says why: sorting, loading, offline on a first run, or no new sentences left', () => {
  const sorting = renderPlan({ next: null, sortingPercent: 42 }, { sorting: { percent: 42 } });
  assert.match(textOf(sorting), /Sorting your sentences into themes… 42%/);
  assert.equal(textOf(sorting).match(/Sorting your sentences/g)?.length, 1, 'said once, in the row');
  assert.match(textOf(renderPlan({ next: null, themes: 'loading' })), /Loading themes…/);
  assert.match(textOf(renderPlan({ next: null, themes: 'offline' })), /Themes load when you’re online\./);
  assert.match(textOf(renderPlan({ next: null })), /No new sentences left in your themes/);
  for (const markup of [sorting, renderPlan({ next: null, themes: 'offline' })]) {
    assert.doesNotMatch(markup, /Start set|Done for today/);
  }
});

test('while the server still sorts but a set is ready, the sorting shows under the card, with its error', () => {
  const text = textOf(renderPlan({ sortingPercent: 70 }, { sorting: { percent: 70, error: 'The classifier is out of credit.' } }));
  assert.match(text, /Start set .* Sorting your sentences into themes… 70% The classifier is out of credit\./);
});

test('a kept session waits on the plan as a Resume row', () => {
  const markup = renderPlan({}, { resumeLabel: `Resume set: ${FIRST.emoji} ${FIRST.title} · 4 of 15` });
  assert.match(textOf(markup), new RegExp(`^Today Wednesday, November 18 .* Resume set: ${FIRST.emoji} ${FIRST.title} · 4 of 15 ›`));
  assert.doesNotMatch(renderPlan(), /Resume set/);
});

test('up next lists the following sets, each a button, with All themes beside its heading', () => {
  const upNext = [{ set: { themeId: SECOND.id, itemIds: ['x', 'y'] }, theme: label(SECOND) }, { set: { themeId: null, itemIds: ['z'] }, theme: UNSORTED }];
  const markup = renderPlan({}, { upNext });
  assert.match(markup, new RegExp(`aria-label="Start set: ${SECOND.title}, 2 sentences"`));
  assert.match(markup, /aria-label="Start set: Unsorted, 1 sentence"/);
  assert.match(textOf(markup), /Up next All themes ›/);
  assert.doesNotMatch(renderPlan({}, { upNext: [], hasThemes: false }), /Up next/);
});

test('the progress line counts what you can say, practice and tomorrow, and the week\'s saved and sorted sentences', () => {
  const text = textOf(renderPlan());
  assert.match(text, /Progress 41 Can say \+6 this week 23 Practicing 9 Tomorrow to practice This week: saved 17 · sorted 12/);
  assert.match(textOf(renderPlan({}, { sortedThisWeek: null })), /sorted —/);
});

test('Card review ends the plan, with classic Study\'s due count or Resume', () => {
  assert.match(textOf(renderPlan()), /Card review 8 due ›$/);
  assert.match(textOf(renderPlan({}, { classicResumable: true })), /Card review Resume ›$/);
});

test('the mode switch is a radio pair whose caption says what the mode asks for', () => {
  const speak = renderPlan();
  assert.match(speak, /role="radiogroup" aria-label="Practice mode"/);
  assert.match(speak, /role="radio" aria-checked="true"[^>]*>.*?Speak<\/button>/);
  assert.match(speak, /Say each answer aloud/);
  const quiet = renderPlan({}, { mode: 'quiet' });
  assert.match(quiet, /role="radio" aria-checked="true"[^>]*>.*?Quiet<\/button>/);
  assert.match(quiet, /Think each answer · quiet practice never earns Can say it/);
});

const row = (fields: Partial<ThemeRow> & Pick<ThemeRow, 'themeId' | 'theme'>): ThemeRow => ({
  newCount: 0, practicingCount: 0, sayableCount: 0, total: 0, set: null, ...fields,
});

test('the themes browser groups themes under their domains, Unsorted last without a heading; a theme with new items starts a set', () => {
  const domains = [
    { id: THEME_DOMAINS[0].id, title: THEME_DOMAINS[0].title, emoji: THEME_DOMAINS[0].emoji, themes: [
      row({ themeId: FIRST.id, theme: label(FIRST), newCount: 30, practicingCount: 2, sayableCount: 4, total: 36, set: { themeId: FIRST.id, itemIds: ['a', 'b'] } }),
    ] },
    { id: THEME_DOMAINS[2].id, title: THEME_DOMAINS[2].title, emoji: THEME_DOMAINS[2].emoji, themes: [
      row({ themeId: THIRD.id, theme: label(THIRD), practicingCount: 1, sayableCount: 3, total: 4 }),
    ] },
  ];
  const unsorted = row({ themeId: null, theme: UNSORTED, newCount: 2, total: 2, set: { themeId: null, itemIds: ['u1', 'u2'] } });
  const markup = renderToStaticMarkup(createElement(ThemesBrowser, { model: { domains, unsorted }, onBack: noop, onStart: noop }));
  const text = textOf(markup);
  assert.match(text, new RegExp(`^All themes ${THEME_DOMAINS[0].emoji} ${THEME_DOMAINS[0].title} ${FIRST.emoji} ${FIRST.title} 30 new · 2 practicing · 4 can say ›`));
  assert.ok(text.includes(`${THEME_DOMAINS[2].emoji} ${THEME_DOMAINS[2].title} ${THIRD.emoji} ${THIRD.title} 0 new · 1 practicing · 3 can say 🗂️ Unsorted`));
  assert.match(text, /🗂️ Unsorted 2 new · 0 practicing · 0 can say ›$/);
  assert.match(markup, new RegExp(`aria-label="Start a set from ${FIRST.title}: 2 of 30 new"`));
  assert.match(markup, new RegExp(`aria-label="${THIRD.title}: you can say 3 of 4" aria-valuemin="0" aria-valuemax="100" aria-valuenow="75"`));
  assert.doesNotMatch(markup, new RegExp(`Start a set from ${THIRD.title}`), 'nothing new to start');
  assert.match(markup, /<section class="mt-6 first:mt-0" aria-label="Unsorted"><ul/, 'Unsorted has no heading');
  assert.match(markup, /aria-label="Back to Today"/);

  const empty = renderToStaticMarkup(createElement(ThemesBrowser, { model: { domains: [], unsorted: null }, onBack: noop, onStart: noop }));
  assert.match(textOf(empty), /No themes yet: they appear as your sentences are sorted\./);
});

function renderSummary(props: Partial<LoopSummaryProps> = {}) {
  return renderToStaticMarkup(createElement(LoopSummary, {
    theme: label(FIRST), headline: 'Set complete · 14 met', graduated: [], tomorrow: 9, todayCount: 14, actions: [{ kind: 'done' }],
    canUndo: false, undoing: false, undoError: '', onUndo: noop, onAction: noop, onClose: noop, ...props,
  }));
}

test('a set\'s summary counts its choices and how its round went, then the goal and tomorrow\'s practice', () => {
  const markup = renderSummary({
    set: { sayable: 3, passive: 6, practicing: 5, firstTry: 3, rounded: 5 },
    actions: summaryActions('set', 0, DAILY_SET_GOAL - 1, NEXT),
    todayCount: DAILY_SET_GOAL - 1,
  });
  const text = textOf(markup);
  assert.match(text, new RegExp(`^${FIRST.emoji} ${FIRST.title} Set complete · 14 met 3 Can say 6 Passive 5 Practicing Round: 3 of 5 on the first try`));
  assert.match(text, new RegExp(`${DAILY_SET_GOAL - 1}/${DAILY_SET_GOAL} ${DAILY_SET_GOAL - 1} of ${DAILY_SET_GOAL} new sentences today Tomorrow: 9 to practice`));
  assert.match(markup, new RegExp(`aria-keyshortcuts="Enter" class="h-14[^"]*">Next set: ${FIRST.emoji} ${FIRST.title}</button><button type="button" class="h-12[^"]*">Done</button>`));
  // A round with nothing recorded says nothing about it.
  assert.doesNotMatch(renderSummary({ set: { sayable: 3, passive: 6, practicing: 0, firstTry: 0, rounded: 0 } }), /Round:/);
});

test('a practice summary counts first tries, hints and not yets, the recall rate, and the sentences now ones you can say', () => {
  const markup = renderSummary({
    theme: null,
    headline: 'Practice complete · 12 sentences',
    practice: { firstTry: 8, withHint: 3, notYet: 1, recallRate: 67, graduated: ['g1', 'g2', 'g3'] },
    graduated: ['Could you keep an eye on my bag?', 'I ran out of milk.', 'I ran out of milk.'],
    actions: [{ kind: 'practice', count: 5 }, { kind: 'done' }],
  });
  const text = textOf(markup);
  assert.match(text, /^Practice Practice complete · 12 sentences 8 First try 3 With a hint 1 Not yet Recall: 67% on the first try Can say it now Could you keep an eye on my bag\? I ran out of milk\. I ran out of milk\./);
  assert.equal(markup.match(/<li class="rounded-lg bg-white/g)?.length, 3, 'one row each, two saved copies of a sentence included');
  assert.match(text, /Practice 5 more Done$/);
  const none = textOf(renderSummary({ theme: null, practice: { firstTry: 0, withHint: 0, notYet: 0, recallRate: null, graduated: [] } }));
  assert.doesNotMatch(none, /Recall:|Can say it now/);
});

test('a session ended early offers Resume as its primary button, the last answer\'s Undo above it, and Done', () => {
  const markup = renderSummary({ headline: 'Ended early · 6 of 14 met', canUndo: true, onResume: noop, actions: [{ kind: 'done' }] });
  assert.match(textOf(markup), /Undo last answer Resume Done$/);
  assert.match(markup, /aria-keyshortcuts="U"/);
  assert.match(markup, /aria-keyshortcuts="Enter R" class="[^"]*bg-indigo-600/, 'Resume is the primary button');
  assert.doesNotMatch(markup, /aria-keyshortcuts="Enter"[^>]*>Done/, 'Done is secondary');
  assert.match(textOf(renderSummary({ canUndo: true, undoing: true })), /Undoing…/);
  const failed = renderSummary({ canUndo: true, undoError: 'Couldn’t undo: you’re offline.' });
  assert.match(failed, /<p class="text-sm text-rose-700" role="alert">Couldn’t undo: you’re offline\.<\/p>/);
  assert.doesNotMatch(renderSummary(), /Resume|Undo last answer/);
});

test('before the history loads the summary\'s goal reads —', () => {
  assert.match(textOf(renderSummary({ todayCount: null })), new RegExp(`— of ${DAILY_SET_GOAL} new sentences today`));
});
