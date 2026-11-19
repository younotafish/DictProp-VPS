import { getItemSpelling, type SentenceData, type StoredItem } from '../../types';
import { isThemeId } from '../../server/src/shared/item-themes';
import { sentenceSourceResolver } from '../sentenceSource';
import { isLoopEligible, isOwnSentence, itemStanding, localDayKey, sentenceTranslation } from './standing';
import { DAILY_SET_GOAL } from './stats';

// Today's planner: which theme today's set comes from, what the set holds and in what order, the sets up next, and the
// numbers the themes browser shows, all over the learner's own sentences (standing.ts isLoopEligible). Pure and
// deterministic: the same library, theme map, clock and device state give the same plan. It runs over the whole
// library (about 17k items, some 3k of them sentences the loop takes) as Today opens and after each set, so it is one
// pass over the items plus sorting; sentences are compared with each other only while a set is filled, and only with
// the set.

const DAY_MS = 86_400_000;

/** Sentences saved this recently count toward their theme's score. */
const RECENT_MS = 14 * DAY_MS;
/** A theme a set was started from on this device within this time is held back, so the days vary. */
export const SET_START_PENALTY_MS = 2 * DAY_MS;
/** A theme with up to this many new sentences gives them all in one set; a bigger one is split into sets of 12 to 23. */
const MAX_SET_SIZE = 20;
/** The size a big theme's sets aim at; none is smaller than the day's goal (DAILY_SET_GOAL). */
const TARGET_SET_SIZE = 15;
/** How many sets the plan simulates after today's. */
const UP_NEXT_COUNT = 3;

/** The set Today offers, or a themes-browser row starts: its theme (null: Unsorted) and its sentences in the order met. */
export interface PlannedSet {
  themeId: string | null;
  itemIds: string[];
}

/** Today's theme on this device for one local day ('YYYY-MM-DD'), so the set doesn't change while it's looked at. */
export interface TodayPin {
  day: string;
  themeId: string;
}

/** A theme's numbers in the themes browser, over the sentences the loop takes, and the set starting it now would hold. */
export interface ThemePlan {
  /** Null for Unsorted: sentences without a theme yet, or with one this build doesn't know. */
  themeId: string | null;
  /** Not yet decided in Today, whatever their classic reviews (a Got it'd sentence included): what its sets take. */
  newCount: number;
  practicingCount: number;
  sayableCount: number;
  /** Every one of its sentences the loop takes, those kept passive included. */
  total: number;
  /** New sentences saved in the last 14 days. */
  recentCount: number;
  /** The set it would give now, in the order met; empty without a new sentence. */
  nextSet: string[];
}

export interface LoopPlan {
  /** Each theme of the taxonomy that holds a sentence the loop takes, by id. */
  themes: Map<string, ThemePlan>;
  /** The sentences in no known theme. Never picked on its own; the themes browser lists it last when it has any. */
  unsorted: ThemePlan;
  /** Today's set: the pinned theme's next set, or the best theme's once the day or the pinned theme's new sentences ran
   *  out. Null while no theme has a new sentence. */
  today: PlannedSet | null;
  /** The pin to keep: `today`'s theme for today, or null with no set. */
  pin: TodayPin | null;
  /** Up to three sets after today's, as if each were started in turn. */
  upNext: PlannedSet[];
  /** The learner's own new sentences that wait for a translation before the loop can take them. */
  awaitingTranslation: number;
}

export interface PlanInput {
  items: readonly StoredItem[];
  /** Each classified item's theme id (services/learningLoop/themeMap.ts); ids this build doesn't know count as none, and
   *  rows for items the loop doesn't take (the words an older build's sweep sorted) are never looked up. */
  themeOf: ReadonlyMap<string, string>;
  now: number;
  /** When a set was last started from each theme on this device (services/learningLoop/sessionStore.ts). */
  recentStarts: Readonly<Record<string, number>>;
  /** Today's pin as stored, if any. */
  pin: TodayPin | null;
}

/**
 * How many sentences a set takes from a theme with `size` new ones: all of them up to 20; beyond that the theme is split
 * into m sets of equal size, ceil(size / m) each, as near 15 as keeps every set at the day's goal of 12 or more:
 * m = min(round(size / 15), floor(size / 12)). So 21 to 23 sentences stay one set, and one set always meets the goal.
 */
export function setSize(size: number): number {
  if (size <= MAX_SET_SIZE) return Math.max(0, size);
  const sets = Math.max(1, Math.min(Math.round(size / TARGET_SET_SIZE), Math.floor(size / DAILY_SET_GOAL)));
  return Math.ceil(size / sets);
}

/**
 * How strongly a theme asks to be today's: 3 points per new sentence saved in the last two weeks (up to 20) plus a
 * quarter point per new sentence (up to 60), less 100 when a set was started from it on this device in the last two
 * days and less 30 when it has fewer new sentences than the day's goal, so its set alone wouldn't meet it.
 */
export function themeScore(
  theme: { themeId: string; size: number; recentCount: number },
  recentStarts: Readonly<Record<string, number>>,
  now: number,
): number {
  let score = 3 * Math.min(theme.recentCount, 20) + Math.min(theme.size, 60) / 4;
  const started = Object.hasOwn(recentStarts, theme.themeId) ? recentStarts[theme.themeId] : undefined;
  if (started !== undefined && now - started < SET_START_PENALTY_MS) score -= 100;
  if (theme.size < DAILY_SET_GOAL) score -= 30;
  return score;
}

/** What a set compares a sentence with the set's others by. */
interface SetProfile {
  /** The words it asks for: its source word as asked, and the spelling of the card it came from (sentenceSource.ts). */
  targets: string[];
}

type ProfileOf = (item: StoredItem) => SetProfile;

/**
 * Each candidate's word: sentences that ask for the same word, as their source word or through the card they came from
 * (another spelling or a listed form reaches the same card), share one key, joined transitively. A sentence that asks
 * for nothing is a word of its own.
 */
function wordKeys(candidates: readonly StoredItem[], profileOf: ProfileOf): (item: StoredItem) => string {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    for (let at = key; at !== root;) {
      const up = parent.get(at) ?? root;
      parent.set(at, root);
      at = up;
    }
    return root;
  };
  for (const item of candidates) {
    const [first, ...rest] = profileOf(item).targets.map(target => `w:${target}`);
    if (first === undefined) continue;
    if (!parent.has(first)) parent.set(first, first);
    for (const target of rest) {
      if (!parent.has(target)) parent.set(target, target);
      const a = find(first);
      const b = find(target);
      // The smaller key wins, so the keys are the same whatever order the library holds the items in.
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  return item => {
    const first = profileOf(item).targets[0];
    return first === undefined ? `i:${item.data.id}` : find(`w:${first}`);
  };
}

/**
 * A set from a theme's new sentences, `candidates` newest saved first: two thirds of it from the newest end, then the
 * rest from the oldest, so the backlog shrinks too, one sentence per word (wordKeys), so a set covers as many
 * expressions as it can and a word's other sentences come back on later days. Only when that can't fill the set does it
 * take more, in rounds: each round adds at most one more sentence of each word, newest first, so no word gets a third
 * sentence before every word has had its second. A set is always setSize's size, so one set meets the day's goal: half
 * the learner's sentences share their word with another. spreadSiblings then orders it.
 */
function composeSet(candidates: readonly StoredItem[], profileOf: ProfileOf): StoredItem[] {
  const size = setSize(candidates.length);
  if (size === 0) return [];
  const keyOf = wordKeys(candidates, profileOf);
  const fromNewest = Math.ceil((2 * size) / 3);
  const used = new Set<string>();
  const chosen: StoredItem[] = [];
  const taken = new Set<number>();
  const take = (index: number) => {
    used.add(keyOf(candidates[index]));
    chosen.push(candidates[index]);
    taken.add(index);
  };
  for (let index = 0; index < candidates.length && chosen.length < fromNewest; index++) {
    if (!used.has(keyOf(candidates[index]))) take(index);
  }
  for (let index = candidates.length - 1; index >= 0 && chosen.length < size; index--) {
    if (!taken.has(index) && !used.has(keyOf(candidates[index]))) take(index);
  }
  while (chosen.length < size) {
    const round = new Set<string>();
    const before = chosen.length;
    for (let index = 0; index < candidates.length && chosen.length < size; index++) {
      const key = keyOf(candidates[index]);
      if (taken.has(index) || round.has(key)) continue;
      round.add(key);
      take(index);
    }
    if (chosen.length === before) break;
  }
  return spreadSiblings(chosen, keyOf);
}

/**
 * A set in the order it is met, so the same word is never asked for twice in a row where the set allows it: each place
 * takes the word with the most sentences left that isn't the last place's (a word holding more than half the set can't
 * be kept apart everywhere), ties to the sentence filling took first. A set of different words keeps filling's order.
 */
function spreadSiblings(set: readonly StoredItem[], keyOf: (item: StoredItem) => string): StoredItem[] {
  const groups = new Map<string, StoredItem[]>();
  for (const item of set) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const filled = new Map(set.map((item, index) => [item, index]));
  const queues = [...groups.values()].map(items => ({ items, next: 0 }));
  const order: StoredItem[] = [];
  let last: (typeof queues)[number] | undefined;
  while (order.length < set.length) {
    let best: (typeof queues)[number] | undefined;
    for (const queue of queues) {
      const left = queue.items.length - queue.next;
      if (left === 0) continue;
      if (!best) {
        best = queue;
        continue;
      }
      const bestLeft = best.items.length - best.next;
      const better = (queue !== last) !== (best !== last) ? queue !== last
        : left !== bestLeft ? left > bestLeft
        : (filled.get(queue.items[queue.next]) ?? 0) < (filled.get(best.items[best.next]) ?? 0);
      if (better) best = queue;
    }
    if (!best) break;
    order.push(best.items[best.next++]);
    last = best;
  }
  return order;
}

/** The profiles of the library's sentences, each made once, the first time a set looks at it. */
function profiles(items: readonly StoredItem[]): ProfileOf {
  let sourceOf: ReturnType<typeof sentenceSourceResolver> | undefined;
  const made = new Map<string, SetProfile>();
  return item => {
    let profile = made.get(item.data.id);
    if (profile) return profile;
    const data = item.data as SentenceData;
    sourceOf ??= sentenceSourceResolver(items);
    const source = sourceOf(data.sourceWord, data.sourceSense);
    const asked = (data.sourceWord || '').toLowerCase().trim();
    profile = { targets: [...new Set([asked, source ? getItemSpelling(source) : ''].filter(Boolean))] };
    made.set(item.data.id, profile);
    return profile;
  };
}

const byNewestSaved = (a: StoredItem, b: StoredItem) =>
  (b.savedAt || 0) - (a.savedAt || 0) || (a.data.id < b.data.id ? -1 : a.data.id > b.data.id ? 1 : 0);

const emptyTheme = (themeId: string | null): ThemePlan & { candidates: StoredItem[] } => ({
  themeId, newCount: 0, practicingCount: 0, sayableCount: 0, total: 0, recentCount: 0, nextSet: [], candidates: [],
});

/** The theme with the highest score among those with new sentences, ties to the lower id; null when none has any. */
function bestTheme(
  pools: ReadonlyMap<string, readonly StoredItem[]>,
  recentCounts: ReadonlyMap<string, number>,
  recentStarts: Readonly<Record<string, number>>,
  now: number,
): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [themeId, candidates] of pools) {
    if (candidates.length === 0) continue;
    const score = themeScore({ themeId, size: candidates.length, recentCount: recentCounts.get(themeId) ?? 0 }, recentStarts, now);
    if (score > bestScore || (score === bestScore && best !== null && themeId < best)) {
      best = themeId;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The plan for Today from the library, the theme map and this device's state. Unsorted sentences are never picked; their
 * set is offered only from the themes browser (`unsorted.nextSet`).
 */
export function planLoop({ items, themeOf, now, recentStarts, pin }: PlanInput): LoopPlan {
  const themes = new Map<string, ThemePlan & { candidates: StoredItem[] }>();
  const unsorted = emptyTheme(null);
  let awaitingTranslation = 0;
  for (const item of items) {
    if (!isLoopEligible(item)) {
      if (!item.isDeleted && !item.isArchived && isOwnSentence(item) && itemStanding(item) === 'new' &&
        sentenceTranslation(item.data) === '' && item.data.text?.trim()) awaitingTranslation++;
      continue;
    }
    const themeId = themeOf.get(item.data.id);
    let theme = unsorted;
    if (themeId !== undefined && isThemeId(themeId)) {
      theme = themes.get(themeId) ?? emptyTheme(themeId);
      themes.set(themeId, theme);
    }
    theme.total++;
    const standing = itemStanding(item);
    if (standing === 'practicing') theme.practicingCount++;
    else if (standing === 'sayable') theme.sayableCount++;
    else if (standing === 'new') {
      theme.newCount++;
      theme.candidates.push(item);
      if (now - (item.savedAt || 0) < RECENT_MS) theme.recentCount++;
    }
  }

  const profileOf = profiles(items);
  const plans = new Map<string, ThemePlan>();
  const pools = new Map<string, StoredItem[]>();
  const recentCounts = new Map<string, number>();
  for (const theme of [...themes.values(), unsorted]) {
    theme.candidates.sort(byNewestSaved);
    theme.nextSet = composeSet(theme.candidates, profileOf).map(item => item.data.id);
  }
  for (const [themeId, { candidates, ...plan }] of themes) {
    plans.set(themeId, plan);
    pools.set(themeId, candidates);
    recentCounts.set(themeId, plan.recentCount);
  }
  const { candidates: _unsortedCandidates, ...unsortedPlan } = unsorted;

  // Today's theme: the pin while it is today's and its theme still has new sentences, else the best theme now.
  const day = localDayKey(now);
  const pinned = pin && pin.day === day && (pools.get(pin.themeId)?.length ?? 0) > 0 ? pin.themeId : null;
  const todayTheme = pinned ?? bestTheme(pools, recentCounts, recentStarts, now);
  if (todayTheme === null) return { themes: plans, unsorted: unsortedPlan, today: null, pin: null, upNext: [], awaitingTranslation };
  const today: PlannedSet = { themeId: todayTheme, itemIds: plans.get(todayTheme)?.nextSet ?? [] };

  // Up next: each set as if the ones before it were started now, its sentences gone from its pool and its theme held
  // back.
  const upNext: PlannedSet[] = [];
  const starts: Record<string, number> = { ...recentStarts, [todayTheme]: now };
  const remaining = new Map(pools);
  const recent = new Map(recentCounts);
  let picked = { themeId: todayTheme, itemIds: today.itemIds };
  for (let step = 0; step < UP_NEXT_COUNT; step++) {
    const taken = new Set(picked.itemIds);
    const left = (remaining.get(picked.themeId) ?? []).filter(item => !taken.has(item.data.id));
    remaining.set(picked.themeId, left);
    recent.set(picked.themeId, left.filter(item => now - (item.savedAt || 0) < RECENT_MS).length);
    const themeId = bestTheme(remaining, recent, starts, now);
    if (themeId === null) break;
    picked = { themeId, itemIds: composeSet(remaining.get(themeId) ?? [], profileOf).map(item => item.data.id) };
    upNext.push(picked);
    starts[themeId] = now;
  }

  return {
    themes: plans,
    unsorted: unsortedPlan,
    today,
    pin: { day, themeId: todayTheme },
    upNext,
    awaitingTranslation,
  };
}
