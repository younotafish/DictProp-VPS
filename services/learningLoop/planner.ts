import { getItemSpelling, isVocabItem, type SentenceData, type StoredItem } from '../../types';
import { isThemeId } from '../../server/src/shared/item-themes';
import { sentenceSourceResolver } from '../sentenceSource';
import { partOfSpeechOf } from '../studyPrompt';
import { normalizeKey } from '../wordMatch';
import { isLoopEligible, isOwnSentence, itemStanding, localDayKey, sentenceTranslation } from './standing';

// Today's planner: which theme today's set comes from, what the set holds and in what order, the sets up next, and the
// numbers the themes browser shows. Pure and deterministic: the same library, theme map, clock and device state give
// the same plan. It runs over the whole library (about 17k items) as Today opens and after each set, so it is one pass
// over the items plus sorting; items are compared with each other only while a set is filled, and only with the set.

const DAY_MS = 86_400_000;

/** Items saved this recently count toward their theme's score. */
const RECENT_MS = 14 * DAY_MS;
/** A theme a set was started from on this device within this time is held back, so the days vary. */
export const SET_START_PENALTY_MS = 2 * DAY_MS;
/** A theme with up to this many new items gives them all in one set; a bigger one is split into sets of 11 to 20. */
export const MAX_SET_SIZE = 20;
/** The size a big theme's sets aim at. */
const TARGET_SET_SIZE = 15;
/** How many sets the plan simulates after today's. */
const UP_NEXT_COUNT = 3;

/** The set Today offers, or a themes-browser row starts: its theme (null: Unsorted) and its items in the order met. */
export interface PlannedSet {
  themeId: string | null;
  itemIds: string[];
}

/** Today's theme on this device for one local day ('YYYY-MM-DD'), so the set doesn't change while it's looked at. */
export interface TodayPin {
  day: string;
  themeId: string;
}

/** A theme's numbers in the themes browser, over the items the loop takes, and the set starting it now would hold. */
export interface ThemePlan {
  /** Null for Unsorted: items without a theme yet, or with one this build doesn't know. */
  themeId: string | null;
  /** Never reviewed: what its sets take. */
  newCount: number;
  practicingCount: number;
  sayableCount: number;
  total: number;
  /** New items saved in the last 14 days. */
  recentCount: number;
  /** The set it would give now, in the order met; empty without a new item. */
  nextSet: string[];
}

export interface LoopPlan {
  /** Each theme of the taxonomy that holds an item the loop takes, by id. */
  themes: Map<string, ThemePlan>;
  /** The items in no known theme. Never picked on its own; the themes browser lists it last when it has items. */
  unsorted: ThemePlan;
  /** Today's set: the pinned theme's next set, or the best theme's once the day or the pinned theme's items ran out.
   *  Null while no theme has a new item. */
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
  /** Each classified item's theme id (services/learningLoop/themeMap.ts); ids this build doesn't know count as none. */
  themeOf: ReadonlyMap<string, string>;
  now: number;
  /** When a set was last started from each theme on this device (services/learningLoop/sessionStore.ts). */
  recentStarts: Readonly<Record<string, number>>;
  /** Today's pin as stored, if any. */
  pin: TodayPin | null;
}

/**
 * How many items a set takes from a theme with `size` new items: all of them up to 20; beyond that the theme is split
 * into m = max(2, round(size / 15)) sets of equal size, ceil(size / m) each.
 */
export function setSize(size: number): number {
  if (size <= MAX_SET_SIZE) return Math.max(0, size);
  const sets = Math.max(2, Math.round(size / TARGET_SET_SIZE));
  return Math.ceil(size / sets);
}

/**
 * How strongly a theme asks to be today's: 3 points per new item saved in the last two weeks (up to 20) plus a quarter
 * point per new item (up to 60), less 100 when a set was started from it on this device in the last two days and less
 * 30 when it has fewer than eight new items, too few for a day's goal.
 */
export function themeScore(
  theme: { themeId: string; size: number; recentCount: number },
  recentStarts: Readonly<Record<string, number>>,
  now: number,
): number {
  let score = 3 * Math.min(theme.recentCount, 20) + Math.min(theme.size, 60) / 4;
  const started = Object.hasOwn(recentStarts, theme.themeId) ? recentStarts[theme.themeId] : undefined;
  if (started !== undefined && now - started < SET_START_PENALTY_MS) score -= 100;
  if (theme.size < 8) score -= 30;
  return score;
}

/**
 * The segments of a Chinese gloss two cards can share: split at ；;，,、/ and spaces, each at least two characters. Notes
 * in brackets, such as （正式文件的）序言's, qualify a gloss rather than give one, so they are left out.
 */
export function glossSegments(chinese: string): string[] {
  return (chinese || '')
    .replace(/（[^（）]*）|\([^()]*\)/g, ' ')
    .split(/[；;，,、/\s]+/)
    .map(segment => segment.trim())
    .filter(segment => [...segment].length >= 2);
}

/** What a set compares an item with the set's others by. */
interface SetProfile {
  /** What it asks for: a card's spelling; a sentence's source word, and the spelling of the card it came from. */
  targets: string[];
  /** A card's gloss segments. */
  segments: string[];
  /** A card's word, and its listed synonyms, keyed alike (normalizeKey). */
  word: string;
  synonyms: string[];
  partOfSpeech: string;
}

type ProfileOf = (item: StoredItem) => SetProfile;

/**
 * The items of a set, in the order met: words first, their parts of speech taking turns where they can (a noun, then
 * a verb, then a noun...), then sentences. Within each, the order filling them gave.
 */
function orderSet(items: readonly StoredItem[], profileOf: ProfileOf): StoredItem[] {
  const groups = new Map<string, StoredItem[]>();
  const sentences: StoredItem[] = [];
  for (const item of items) {
    if (!isVocabItem(item)) { sentences.push(item); continue; }
    const key = profileOf(item).partOfSpeech;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  // Each turn takes the part of speech with the most words left that isn't the one just taken; ties go to the one met first.
  const queues = [...groups.entries()].map(([key, words]) => ({ key, words, next: 0 }));
  const words: StoredItem[] = [];
  let last: string | undefined;
  for (let left = items.length - sentences.length; left > 0; left--) {
    let best: (typeof queues)[number] | undefined;
    for (const queue of queues) {
      const remaining = queue.words.length - queue.next;
      if (remaining === 0 || (queue.key === last && queues.some(other => other !== queue && other.next < other.words.length))) continue;
      if (!best || remaining > best.words.length - best.next) best = queue;
    }
    if (!best) break;
    words.push(best.words[best.next++]);
    last = best.key;
  }
  return [...words, ...sentences];
}

/**
 * A set from a theme's new items, `candidates` newest saved first: two thirds of it from the newest end and the rest from
 * the oldest, so the backlog shrinks too. Filling skips an item that would share the set with one it interferes with:
 * another meaning of a spelling in the set (or a sentence asking for a word the set asks for, as its card or another
 * sentence of it does), or a card whose Chinese gloss shares a segment with a card in the set, or that lists one of
 * them as a synonym, or is listed as one. A skipped item stays in the pool for a later set.
 */
function composeSet(candidates: readonly StoredItem[], profileOf: ProfileOf): StoredItem[] {
  const size = setSize(candidates.length);
  const fromNewest = Math.ceil((2 * size) / 3);
  const targets = new Set<string>();
  const segments = new Set<string>();
  const words = new Set<string>();
  const synonyms = new Set<string>();
  const chosen: StoredItem[] = [];
  const taken = new Set<number>();
  const tryTake = (index: number) => {
    const profile = profileOf(candidates[index]);
    if (profile.targets.some(target => targets.has(target)) || profile.segments.some(segment => segments.has(segment)) ||
      (profile.word !== '' && synonyms.has(profile.word)) || profile.synonyms.some(synonym => words.has(synonym))) return;
    for (const target of profile.targets) targets.add(target);
    for (const segment of profile.segments) segments.add(segment);
    if (profile.word !== '') words.add(profile.word);
    for (const synonym of profile.synonyms) synonyms.add(synonym);
    chosen.push(candidates[index]);
    taken.add(index);
  };
  for (let index = 0; index < candidates.length && chosen.length < fromNewest; index++) tryTake(index);
  for (let index = candidates.length - 1; index >= 0 && chosen.length < size; index--) {
    if (!taken.has(index)) tryTake(index);
  }
  return orderSet(chosen, profileOf);
}

/** The profiles of the library's items, each made once, the first time a set looks at it. */
function profiles(items: readonly StoredItem[]): ProfileOf {
  let sourceOf: ReturnType<typeof sentenceSourceResolver> | undefined;
  const made = new Map<string, SetProfile>();
  return item => {
    let profile = made.get(item.data.id);
    if (profile) return profile;
    if (isVocabItem(item)) {
      const card = item.data;
      profile = {
        targets: [getItemSpelling(item)],
        segments: glossSegments(card.chinese),
        word: normalizeKey(card.word),
        synonyms: (card.synonyms ?? []).filter(synonym => typeof synonym === 'string').map(normalizeKey).filter(Boolean),
        partOfSpeech: partOfSpeechOf(card.sense),
      };
    } else {
      const data = item.data as SentenceData;
      sourceOf ??= sentenceSourceResolver(items);
      const source = sourceOf(data.sourceWord, data.sourceSense);
      const asked = (data.sourceWord || '').toLowerCase().trim();
      const targets = new Set([asked, source ? getItemSpelling(source) : ''].filter(Boolean));
      profile = { targets: [...targets], segments: [], word: '', synonyms: [], partOfSpeech: '' };
    }
    made.set(item.data.id, profile);
    return profile;
  };
}

const byNewestSaved = (a: StoredItem, b: StoredItem) =>
  (b.savedAt || 0) - (a.savedAt || 0) || (a.data.id < b.data.id ? -1 : a.data.id > b.data.id ? 1 : 0);

const emptyTheme = (themeId: string | null): ThemePlan & { candidates: StoredItem[] } => ({
  themeId, newCount: 0, practicingCount: 0, sayableCount: 0, total: 0, recentCount: 0, nextSet: [], candidates: [],
});

/** The theme with the highest score among those with new items, ties to the lower id; null when none has any. */
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
 * The plan for Today from the library, the theme map and this device's state. Unsorted items are never picked; their
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

  // Today's theme: the pin while it is today's and its theme still has new items, else the best theme now.
  const day = localDayKey(now);
  const pinned = pin && pin.day === day && (pools.get(pin.themeId)?.length ?? 0) > 0 ? pin.themeId : null;
  const todayTheme = pinned ?? bestTheme(pools, recentCounts, recentStarts, now);
  if (todayTheme === null) return { themes: plans, unsorted: unsortedPlan, today: null, pin: null, upNext: [], awaitingTranslation };
  const today: PlannedSet = { themeId: todayTheme, itemIds: plans.get(todayTheme)?.nextSet ?? [] };

  // Up next: each set as if the ones before it were started now, its items gone from its pool and its theme held back.
  const upNext: PlannedSet[] = [];
  const starts: Record<string, number> = { ...recentStarts, [todayTheme]: now };
  const remaining = new Map(pools);
  const recent = new Map(recentCounts);
  let picked = today;
  for (let step = 0; step < UP_NEXT_COUNT; step++) {
    if (picked.themeId !== null) {
      const taken = new Set(picked.itemIds);
      const left = (remaining.get(picked.themeId) ?? []).filter(item => !taken.has(item.data.id));
      remaining.set(picked.themeId, left);
      recent.set(picked.themeId, left.filter(item => now - (item.savedAt || 0) < RECENT_MS).length);
    }
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
