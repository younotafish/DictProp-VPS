import Fuse from 'fuse.js';
import { getItemSpelling, getItemTitle } from '../types';
import type { ItemGroup, SearchResult, StoredItem, VocabCard } from '../types';
import { sortStoredSensesByUsage } from './usageAudit';
import { needsReview } from './sentenceReviewState';

export type NotebookSort = 'familiarity' | 'alphabetical';
export type NotebookFilter = 'all' | 'vocab' | 'phrase';
/** The list section a group is shown in; a card opened from it pages through that section. */
export type NotebookSection = 'main' | 'due' | 'archived';

/** The filter button's cycle: all items, then words only, then phrases only. */
export const nextNotebookFilter = (filter: NotebookFilter): NotebookFilter => {
  if (filter === 'all') return 'vocab';
  if (filter === 'vocab') return 'phrase';
  return 'all';
};

/** The sort button's toggle between review priority and A–Z. */
export const nextNotebookSort = (sort: NotebookSort): NotebookSort =>
  sort === 'familiarity' ? 'alphabetical' : 'familiarity';

/** What the filter lists, as a noun for `count` of them (1 word, 3 phrases, 2 items); plural without a count. */
export const filterNoun = (filter: NotebookFilter, count?: number): string => {
  const noun = filter === 'phrase' ? 'phrase' : filter === 'vocab' ? 'word' : 'item';
  return count === 1 ? noun : `${noun}s`;
};

/**
 * Whether the notebook counts a card as due at `now`: never reviewed, or reviewed and due again (needsReview, the
 * rule the reading tabs use too), and not archived. This one rule orders the list, fills the due block, draws the
 * rows' Due badges and strips and makes the header's "to review" count, so all of them agree. Study's dashboard
 * counts only reviewed cards as due, which is why the header says "to review" rather than "due".
 */
export const isNotebookDue = (item: StoredItem, now: number): boolean =>
  !item.isArchived && needsReview(item.srs, now);

export interface NotebookList {
  /** The listed unarchived items, grouped by spelling in display order. */
  groups: ItemGroup[];
  archived: StoredItem[];
  archivedGroups: ItemGroup[];
  /** While searching, the due items the results leave out, weakest first. Empty otherwise. */
  dueGroups: ItemGroup[];
  /** The time the list counted what's due from; its rows' Due badges and the header's counts count from it too. */
  now: number;
}

// Lowercased word, phrase and Chinese fields, cached per content object. A review replaces an item's
// wrapper but keeps its data, so the cache survives reviews.
const searchTextCache = new WeakMap<object, string>();

const searchText = (item: StoredItem): string => {
  let text = searchTextCache.get(item.data);
  if (text === undefined) {
    const data = item.data as Partial<VocabCard & SearchResult>;
    text = [data.word, data.query, data.chinese, data.translation].filter(Boolean).join('\n').toLowerCase();
    searchTextCache.set(item.data, text);
  }
  return text;
};

// Spelling per content object, which grouping and search read for every item on each rebuild.
const spellingCache = new WeakMap<object, string>();

/** An item's spelling (getItemSpelling), cached per content object: the title the list groups its senses under. */
export const spellingOf = (item: StoredItem): string => {
  if (!item?.data) return '';
  let spelling = spellingCache.get(item.data);
  if (spelling === undefined) {
    spelling = getItemSpelling(item);
    spellingCache.set(item.data, spelling);
  }
  return spelling;
};

// The fuzzy index only serves typo searches, so it's built on first use. It holds the distinct spellings,
// which reviews and edits leave as they were, so it's rebuilt only when a spelling comes or goes.
let fuzzyIndex: { spellings: string[]; fuse: Fuse<string> } | null = null;

const sameSpellings = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((spelling, i) => spelling === b[i]);

// The spellings that fuzzily match, best first.
const fuzzySpellings = (items: StoredItem[], needle: string): string[] => {
  const distinct = new Set<string>();
  for (const item of items) distinct.add(spellingOf(item));
  distinct.delete('');
  const spellings = [...distinct];
  if (!fuzzyIndex || !sameSpellings(fuzzyIndex.spellings, spellings)) {
    fuzzyIndex = { spellings, fuse: new Fuse(spellings, { threshold: 0.3, ignoreLocation: true }) };
  }
  return fuzzyIndex.fuse.search(needle).map(result => result.item);
};

/** The items with one of `spellings`, in library order: every sense of each. */
export const withAllSenses = (items: StoredItem[], spellings: Iterable<string>): StoredItem[] => {
  const wanted = new Set(spellings);
  wanted.delete('');
  return items.filter(item => wanted.has(spellingOf(item)));
};

/**
 * Items whose word, phrase or Chinese fields contain the query, plus every other sense of each matched
 * spelling; null when nothing contains the query.
 */
export const findLiteralMatches = (items: StoredItem[], query: string): StoredItem[] | null => {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  const hits = items.filter(item => item?.data && searchText(item).includes(needle));
  return hits.length > 0 ? withAllSenses(items, hits.map(spellingOf)) : null;
};

/**
 * Items whose spelling fuzzily matches the query, with their other senses, so typos still find their word, and the
 * matched spellings in Fuse's order, best first. It scans every spelling, tens of ms, so it's the fallback for a
 * query nothing contains.
 */
export const findFuzzyMatchesRanked = (items: StoredItem[], query: string): { matches: StoredItem[]; order: string[] } => {
  const order = fuzzySpellings(items, query.trim().toLowerCase());
  return { matches: withAllSenses(items, order), order };
};

/** findFuzzyMatchesRanked's matches alone. */
export const findFuzzyMatches = (items: StoredItem[], query: string): StoredItem[] =>
  findFuzzyMatchesRanked(items, query).matches;

/** The whole search at once: literal matches, else fuzzy ones. The notebook runs the two steps separately. */
export const findNotebookMatches = (items: StoredItem[], query: string): StoredItem[] =>
  findLiteralMatches(items, query) ?? findFuzzyMatches(items, query);

const byTitle = (a: StoredItem, b: StoredItem): number => getItemTitle(a).localeCompare(getItemTitle(b));

// Due items first (isNotebookDue), weakest memory then longest overdue; the rest by next review.
const byReviewPriority = (now: number) => (a: StoredItem, b: StoredItem): number => {
  const isDueA = isNotebookDue(a, now);
  const isDueB = isNotebookDue(b, now);
  if (isDueA !== isDueB) return isDueA ? -1 : 1;
  if (isDueA) {
    const strength = (a.srs?.memoryStrength || 0) - (b.srs?.memoryStrength || 0);
    if (strength !== 0) return strength;
  }
  return (a.srs?.nextReview || 0) - (b.srs?.nextReview || 0);
};

/** Groups items by spelling in order of first appearance, each group's senses sorted by usage. */
export const groupByTitle = (items: StoredItem[]): ItemGroup[] => {
  const groups = new Map<string, StoredItem[]>();
  for (const item of items) {
    const title = spellingOf(item);
    if (!title) continue;
    const group = groups.get(title);
    if (group) group.push(item);
    else groups.set(title, [item]);
  }
  return Array.from(groups, ([title, senses]) => ({ title, items: sortStoredSensesByUsage(senses) }));
};

const sameItems = (a: StoredItem[], b: StoredItem[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i]);

// Each group of `groups` that has the same senses in the same order as the like-titled group of `before`, as
// that earlier object, so a rebuild that changed one card leaves every other row's group, and the row, alone.
const reuseGroups = (groups: ItemGroup[], before: ItemGroup[] | undefined): ItemGroup[] => {
  if (!before?.length) return groups;
  const byTitle = new Map(before.map(group => [group.title, group]));
  return groups.map(group => {
    const earlier = byTitle.get(group.title);
    return earlier && sameItems(earlier.items, group.items) ? earlier : group;
  });
};

/** A search's order: each matched spelling's rank (see services/notebook/searchRank.ts), lowest first. */
export type SearchRank = ReadonlyMap<string, number>;

/**
 * The notebook's sections. `matches` is the search result, or null when not searching; while searching,
 * the due items outside the results are listed after them so review can continue, and `rank` puts the best
 * matches first, the list's sort ordering each rank. Given the `previous` list, a group whose senses haven't
 * changed keeps its earlier object, in the same section.
 */
export const buildNotebookList = (
  items: StoredItem[],
  matches: StoredItem[] | null,
  sort: NotebookSort,
  filter: NotebookFilter,
  now = Date.now(),
  previous?: NotebookList | null,
  rank?: SearchRank,
): NotebookList => {
  const isListed = (item: StoredItem) =>
    !!item?.data?.id && !item.isDeleted && (filter === 'all' || item.type === filter);
  const byPriority = byReviewPriority(now);
  const rankOf = (item: StoredItem) => rank?.get(spellingOf(item)) ?? Number.MAX_SAFE_INTEGER;
  const byRankThen = (order: (a: StoredItem, b: StoredItem) => number) =>
    rank ? (a: StoredItem, b: StoredItem) => rankOf(a) - rankOf(b) || order(a, b) : order;

  const active: StoredItem[] = [];
  const archived: StoredItem[] = [];
  for (const item of matches ?? items) {
    if (isListed(item)) (item.isArchived ? archived : active).push(item);
  }
  active.sort(byRankThen(sort === 'alphabetical' ? byTitle : byPriority));
  archived.sort(byRankThen(byTitle));

  let dueGroups: ItemGroup[] = [];
  if (matches) {
    const shown = new Set(active);
    const due = items.filter(item => isListed(item) && !shown.has(item) && isNotebookDue(item, now));
    dueGroups = groupByTitle(due.sort(byPriority));
  }

  return {
    groups: reuseGroups(groupByTitle(active), previous?.groups),
    archived,
    archivedGroups: reuseGroups(groupByTitle(archived), previous?.archivedGroups),
    dueGroups: reuseGroups(dueGroups, previous?.dueGroups),
    now,
  };
};

/** The counts in the notebook's header, archived and deleted items aside. */
export interface NotebookStats {
  /** Spellings under the filter: outside a search, the listed groups; during one, still the whole notebook's. */
  saved: number;
  /** Senses of every type reviewed since local midnight. */
  reviewedToday: number;
  /** Spellings under the filter with a sense due by isNotebookDue: exactly those the list shows with a Due badge. */
  toReview: number;
}

/** The header's counts at the list's clock `now`, from every item rather than a search's results. */
export const notebookStats = (items: StoredItem[], filter: NotebookFilter, now: number): NotebookStats => {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime();
  let reviewedToday = 0;
  const saved = new Set<string>();
  const toReview = new Set<string>();
  for (const item of items) {
    if (!item || item.isDeleted || item.isArchived) continue;
    // A reset stamps lastReviewDate as well, and leaves no reviews.
    if (item.srs && item.srs.totalReviews > 0 && item.srs.lastReviewDate >= todayTs) reviewedToday++;
    if (!item.data?.id || (filter !== 'all' && item.type !== filter)) continue;
    const spelling = spellingOf(item);
    if (!spelling) continue;
    saved.add(spelling);
    if (isNotebookDue(item, now)) toReview.add(spelling);
  }
  return { saved: saved.size, reviewedToday, toReview: toReview.size };
};

export interface ListNoteContent {
  message: string;
  /** Offer to look the query up with AI. */
  offerLookUp: boolean;
  /** Offer to switch the filter to all items. */
  offerShowAll: boolean;
}

/**
 * What the list says when nothing is listed above its due and archived sections, and the ways out it offers;
 * null when there's nothing to say. A search says nothing until its results have settled.
 */
export const listNoteFor = ({ searchQuery, searchSettled, groupCount, archivedCount, filter, canLookUp }: {
  searchQuery: string;
  searchSettled: boolean;
  groupCount: number;
  archivedCount: number;
  filter: NotebookFilter;
  canLookUp: boolean;
}): ListNoteContent | null => {
  if (groupCount > 0) return null;
  if (searchQuery ? !searchSettled : archivedCount === 0 && filter === 'all') return null;
  const noun = filterNoun(filter);
  const message = searchQuery
    ? (archivedCount > 0 ? `Only archived ${noun} match “${searchQuery}”.` : `No saved ${noun} match “${searchQuery}”.`)
    : (archivedCount > 0 ? `All your ${noun} are archived.` : `No ${noun} saved yet.`);
  return { message, offerLookUp: !!searchQuery && canLookUp, offerShowAll: filter !== 'all' };
};

/** One row of the virtualized list. `key` keeps each row's state with its group. */
export type NotebookRow =
  | { key: string; type: 'group'; group: ItemGroup; section: NotebookSection }
  | { key: string; type: 'due-header'; count: number }
  | { key: string; type: 'archived-header'; count: number }
  | { key: string; type: 'archived-toggle'; count: number }
  | { key: string; type: 'compare-banner' }
  | { key: string; type: 'list-note' };

/**
 * The list flattened for virtualization: the compare banner, the list note and the groups. A search then lists its
 * archived matches open under an 'Archived matches · N' heading (N spellings) and the due groups it leaves out under
 * theirs; browsing ends with the archived toggle, and the archived groups when it's open.
 */
export const buildNotebookRows = (
  list: Pick<NotebookList, 'groups' | 'dueGroups' | 'archived' | 'archivedGroups'>,
  { searching, compareMode, showListNote, showArchived }: {
    searching: boolean; compareMode: boolean; showListNote: boolean; showArchived: boolean;
  },
): NotebookRow[] => {
  const rows: NotebookRow[] = [];
  const addGroups = (groups: ItemGroup[], section: NotebookSection) => groups.forEach(group => {
    rows.push({ key: `${section}:${group.title}`, type: 'group', group, section });
  });

  if (compareMode) rows.push({ key: 'compare-banner', type: 'compare-banner' });
  if (showListNote) rows.push({ key: 'list-note', type: 'list-note' });
  addGroups(list.groups, 'main');
  if (searching && list.archivedGroups.length > 0) {
    rows.push({ key: 'archived-header', type: 'archived-header', count: list.archivedGroups.length });
    addGroups(list.archivedGroups, 'archived');
  }
  // While searching, the due items outside the results follow them
  if (list.dueGroups.length > 0) {
    rows.push({ key: 'due-header', type: 'due-header', count: list.dueGroups.length });
    addGroups(list.dueGroups, 'due');
  }
  if (!searching && list.archived.length > 0) {
    rows.push({ key: 'archived-toggle', type: 'archived-toggle', count: list.archived.length });
    if (showArchived) addGroups(list.archivedGroups, 'archived');
  }
  return rows;
};
