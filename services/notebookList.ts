import Fuse from 'fuse.js';
import { getItemSpelling, getItemTitle } from '../types';
import type { ItemGroup, SearchResult, StoredItem, VocabCard } from '../types';
import { sortStoredSensesByUsage } from './usageAudit';

export type NotebookSort = 'familiarity' | 'alphabetical';
export type NotebookFilter = 'all' | 'vocab' | 'phrase';

export interface NotebookList {
  /** Listed active items, in display order. */
  active: StoredItem[];
  groups: ItemGroup[];
  archived: StoredItem[];
  archivedGroups: ItemGroup[];
  /** While searching, the due items the results leave out, weakest first. Empty otherwise. */
  dueGroups: ItemGroup[];
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

// The fuzzy index only serves typo searches, so it's built on first use and kept per items array.
const fuzzyIndexes = new WeakMap<StoredItem[], Fuse<StoredItem>>();

const fuzzyMatches = (items: StoredItem[], query: string): StoredItem[] => {
  let fuse = fuzzyIndexes.get(items);
  if (!fuse) {
    fuse = new Fuse(items, { keys: ['data.word', 'data.query'], threshold: 0.3, ignoreLocation: true });
    fuzzyIndexes.set(items, fuse);
  }
  return fuse.search(query).map(result => result.item);
};

/**
 * Items whose word, phrase or Chinese fields contain the query, plus every other sense of each matched
 * spelling. When nothing contains the query, a fuzzy match on the spelling still finds typos.
 */
export const findNotebookMatches = (items: StoredItem[], query: string): StoredItem[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  let hits = items.filter(item => item?.data && searchText(item).includes(needle));
  if (hits.length === 0) hits = fuzzyMatches(items, needle);
  const spellings = new Set(hits.map(getItemSpelling));
  spellings.delete('');
  return items.filter(item => item?.data && spellings.has(getItemSpelling(item)));
};

const byTitle = (a: StoredItem, b: StoredItem): number => getItemTitle(a).localeCompare(getItemTitle(b));

// Due items first, weakest memory then longest overdue; the rest by next review.
const byReviewPriority = (now: number) => (a: StoredItem, b: StoredItem): number => {
  const dueA = a.srs?.nextReview || 0;
  const dueB = b.srs?.nextReview || 0;
  const isDueA = dueA <= now;
  const isDueB = dueB <= now;
  if (isDueA !== isDueB) return isDueA ? -1 : 1;
  if (isDueA) {
    const strength = (a.srs?.memoryStrength || 0) - (b.srs?.memoryStrength || 0);
    if (strength !== 0) return strength;
  }
  return dueA - dueB;
};

/** Groups items by spelling in order of first appearance, each group's senses sorted by usage. */
export const groupByTitle = (items: StoredItem[]): ItemGroup[] => {
  const groups = new Map<string, StoredItem[]>();
  for (const item of items) {
    const title = getItemSpelling(item);
    if (!title) continue;
    const group = groups.get(title);
    if (group) group.push(item);
    else groups.set(title, [item]);
  }
  return Array.from(groups, ([title, senses]) => ({ title, items: sortStoredSensesByUsage(senses) }));
};

/**
 * The notebook's sections. `matches` is the search result, or null when not searching; while searching,
 * the due items outside the results are listed after them so review can continue.
 */
export const buildNotebookList = (
  items: StoredItem[],
  matches: StoredItem[] | null,
  sort: NotebookSort,
  filter: NotebookFilter,
  now = Date.now(),
): NotebookList => {
  const isListed = (item: StoredItem) =>
    !!item?.data?.id && !item.isDeleted && (filter === 'all' || item.type === filter);
  const byPriority = byReviewPriority(now);

  const active: StoredItem[] = [];
  const archived: StoredItem[] = [];
  for (const item of matches ?? items) {
    if (isListed(item)) (item.isArchived ? archived : active).push(item);
  }
  active.sort(sort === 'alphabetical' ? byTitle : byPriority);
  archived.sort(byTitle);

  let dueGroups: ItemGroup[] = [];
  if (matches) {
    const shown = new Set(active);
    const due = items.filter(item =>
      isListed(item) && !item.isArchived && !shown.has(item) && (item.srs?.nextReview || 0) <= now);
    dueGroups = groupByTitle(due.sort(byPriority));
  }

  return { active, groups: groupByTitle(active), archived, archivedGroups: groupByTitle(archived), dueGroups };
};
