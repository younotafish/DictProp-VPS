import type { StoredItem } from '../../types';
import { THEME_DOMAINS, themeById } from '../../server/src/shared/item-themes';
import type { LoopPlan, PlannedSet, ThemePlan } from '../../services/learningLoop/planner';
import type { ActiveUnit } from '../../services/learningLoop/sessionStore';
import { isLoopEligible, localDayKey } from '../../services/learningLoop/standing';
import { DAILY_SET_GOAL } from '../../services/learningLoop/stats';
import { needsReview } from '../../services/sentenceOrdering';

// What Today's screens show, worked out as plain data from the plan, the active unit and the library, so the screens
// only draw it and the tests can pin every state without a browser. The plan's own rules live in services/learningLoop;
// this module words and arranges what they decide, and says where the active unit stands.

/** How Today names a theme: the taxonomy's emoji and title. */
export interface ThemeLabel {
  emoji: string;
  title: string;
}

/** What Today shows: the plan, the themes browser, or Card review. A unit's sentences open in the lesson, over the tab. */
export type TodayScreen = 'plan' | 'themes' | 'classic';

/**
 * Which of Today's own handlers listen: Enter on the plan, and Esc in the themes browser. Card review keeps classic
 * Study's keys and Esc, so Today's stay off there, and nothing of Today's listens while something covers the tab (the
 * lesson a unit opens in, or a card view, which has the keys).
 */
export function todayHandlers(screen: TodayScreen, covered: boolean): { keys: boolean; escape: boolean } {
  if (covered) return { keys: false, escape: false };
  return { keys: screen === 'plan', escape: screen === 'themes' };
}

/** Sentences with no theme yet, or one this build doesn't know. */
export const UNSORTED: ThemeLabel = { emoji: '🗂️', title: 'Unsorted' };

export function themeLabel(themeId: string | null): ThemeLabel {
  const theme = themeId === null ? undefined : themeById(themeId);
  return theme ? { emoji: theme.emoji, title: theme.title } : UNSORTED;
}

/** A count of sentences in words: '1 sentence', '14 sentences'. */
export const sentenceCount = (count: number): string => `${count} ${count === 1 ? 'sentence' : 'sentences'}`;

/** The plan's date line: 'Wednesday, November 18'. */
export const formatPlanDate = (now: number): string =>
  new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

/** The active unit as the library holds it now. */
export interface UnitProgress {
  unit: ActiveUnit;
  /** Its live sentences, in lesson order: still in the library, not deleted or archived, and still Today's. */
  items: StoredItem[];
  /** Of them, those that don't need review: memorized. */
  memorized: number;
  /** Where the first one that still needs review stands in `items`, which Continue opens at; -1 once the unit is done. */
  next: number;
}

/**
 * Where the active unit stands at `now`: unfinished while any of its live sentences needs review, whatever day it
 * started, and done once none does. Null without a unit, or once none of its sentences is live, when it is absent.
 */
export function unitProgress(unit: ActiveUnit | null, items: readonly StoredItem[], now: number): UnitProgress | null {
  if (!unit) return null;
  const ids = new Set(unit.itemIds);
  const found = new Map<string, StoredItem>();
  for (const item of items) {
    if (ids.has(item.data.id) && !found.has(item.data.id) && isLoopEligible(item)) found.set(item.data.id, item);
  }
  const live = unit.itemIds.flatMap(id => found.get(id) ?? []);
  if (live.length === 0) return null;
  const toReview = live.map(item => needsReview(item.srs, now));
  return { unit, items: live, memorized: toReview.filter(due => !due).length, next: toReview.indexOf(true) };
}

/** Whether the unit is unfinished: Continue offers it, and no other unit takes its sentences. */
export const isUnfinished = (progress: UnitProgress | null): boolean => !!progress && progress.next >= 0;

/**
 * What the plan leaves out of every unit it composes (PlanInput.exclude): the active unit's sentences while it is
 * unfinished at `now`, so no other unit takes them. Nothing once it is done, or with no unit.
 */
export function unitExclude(unit: ActiveUnit | null, items: readonly StoredItem[], now: number): ReadonlySet<string> | undefined {
  return unit && isUnfinished(unitProgress(unit, items, now)) ? new Set(unit.itemIds) : undefined;
}

/** Where the theme map stands, for a plan with no unit: still loading, unreachable with nothing kept, or in hand. */
export type ThemesStatus = 'loading' | 'offline' | 'ready';

/** The plan's unit card, in the first of its states that holds. */
export type PlanCardModel =
  /** An unfinished active unit: 'N sentences · M memorized', a bar of M of N, and Continue. */
  | { kind: 'continue'; theme: ThemeLabel; size: number; memorized: number }
  /** No unfinished unit, the goal not met, and a next unit: 'N sentences' and Start unit. */
  | { kind: 'start'; set: PlannedSet; theme: ThemeLabel; size: number }
  /**
   * The goal met: 'Done for today ✓', the active unit when it was done today ('✓ <theme> · N memorized'), and the plan's
   * next unit, when there is one, as 'Another unit: <theme>'.
   */
  | { kind: 'done'; finished: { theme: ThemeLabel; memorized: number } | null; another: { set: PlannedSet; theme: ThemeLabel } | null }
  /** No unit to offer, while the server sorts the sentences into themes. */
  | { kind: 'sorting'; percent: number }
  | { kind: 'loading' }
  /** No theme map on this device, and the server out of reach: 'Themes load when you're online.' */
  | { kind: 'offline' }
  /** No theme has a sentence to review: 'Nothing to review in your themes'. */
  | { kind: 'empty' };

export interface PlanCardInput {
  /** The active unit as the library holds it now (unitProgress), or null with none. */
  unit: UnitProgress | null;
  /** Today's count toward the goal (todaySetCount); before the history loads, only this device's unsent reviews. */
  todayCount: number;
  historyLoaded: boolean;
  /** The plan's next unit (LoopPlan.today). */
  next: PlannedSet | null;
  themes: ThemesStatus;
  /** How far the server's sorting has got (themeMap.ts sortingProgress), while it still has sentences to sort; null
   *  otherwise. */
  sortingPercent: number | null;
  now: number;
}

/**
 * The unit card: Continue an unfinished unit; else, until the goal is met, Start the plan's next unit; once it is met,
 * Done for today; and with no unit to offer, why. A done unit shows only on the local day it started; an older one is
 * passed over. The goal reads as met only once the history has loaded, as every count drawn from it.
 */
export function planCardModel({ unit, todayCount, historyLoaded, next, themes, sortingPercent, now }: PlanCardInput): PlanCardModel {
  if (unit && unit.next >= 0) {
    return { kind: 'continue', theme: themeLabel(unit.unit.themeId), size: unit.items.length, memorized: unit.memorized };
  }
  const goalMet = historyLoaded && todayCount >= DAILY_SET_GOAL;
  if (!goalMet && next) return { kind: 'start', set: next, theme: themeLabel(next.themeId), size: next.itemIds.length };
  if (goalMet) {
    const doneToday = unit && localDayKey(unit.unit.startedAt) === localDayKey(now);
    return {
      kind: 'done',
      finished: doneToday ? { theme: themeLabel(unit.unit.themeId), memorized: unit.memorized } : null,
      another: next ? { set: next, theme: themeLabel(next.themeId) } : null,
    };
  }
  if (themes !== 'ready') return { kind: themes };
  return sortingPercent !== null ? { kind: 'sorting', percent: sortingPercent } : { kind: 'empty' };
}

/** How many units Up next lists. */
const UP_NEXT_ROWS = 3;

/**
 * The units Up next lists: up to three after the one the card offers. With an unfinished unit on the card the plan's
 * next unit is the first of them; otherwise the card offers that one itself, as Start unit or Another unit.
 */
export function upNextUnits(card: PlanCardModel, plan: Pick<LoopPlan, 'today' | 'upNext'>): { set: PlannedSet; theme: ThemeLabel }[] {
  const sets = card.kind === 'continue' && plan.today ? [plan.today, ...plan.upNext] : plan.upNext;
  return sets.slice(0, UP_NEXT_ROWS).map(set => ({ set, theme: themeLabel(set.themeId) }));
}

/** A theme in the themes browser: its numbers, and the unit a tap starts (null without a sentence to review). */
export interface ThemeRow {
  themeId: string | null;
  theme: ThemeLabel;
  toReviewCount: number;
  memorizedCount: number;
  total: number;
  set: PlannedSet | null;
}

/** The themes browser's domains, each with its themes that hold a sentence, and Unsorted, when it has any. */
export interface ThemesBrowserModel {
  domains: { id: string; title: string; emoji: string; themes: ThemeRow[] }[];
  unsorted: ThemeRow | null;
}

const themeRow = (plan: ThemePlan, theme: ThemeLabel): ThemeRow => ({
  themeId: plan.themeId,
  theme,
  toReviewCount: plan.toReviewCount,
  memorizedCount: plan.memorizedCount,
  total: plan.total,
  set: plan.nextSet.length > 0 ? { themeId: plan.themeId, itemIds: plan.nextSet } : null,
});

/**
 * The themes browser from the plan, in the taxonomy's order, which never changes, so a theme keeps its place as its
 * numbers move. Themes and domains without one of Today's sentences are left out; Unsorted comes last.
 */
export function themesBrowserModel(plan: Pick<LoopPlan, 'themes' | 'unsorted'>): ThemesBrowserModel {
  const domains = THEME_DOMAINS.flatMap(domain => {
    const themes = domain.themes.flatMap(theme => {
      const planned = plan.themes.get(theme.id);
      return planned ? [themeRow(planned, { emoji: theme.emoji, title: theme.title })] : [];
    });
    return themes.length > 0 ? [{ id: domain.id, title: domain.title, emoji: domain.emoji, themes }] : [];
  });
  return { domains, unsorted: plan.unsorted.total > 0 ? themeRow(plan.unsorted, UNSORTED) : null };
}
