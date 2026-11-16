import { isVocabItem, type StoredItem, type VocabCard } from '../types';
import { cardBase, findDuplicateClusters, splitForms } from './wordMatch';
import { dryRunMerge, mergeScore, type MergeEffect } from './mergeDuplicates';

/** How much of a definition the duplicates modal shows for a base word whose merge starts unticked. */
const DEFINITION_SNIPPET_CHARS = 60;

/**
 * One cluster of variant-duplicate words (base words ["run", "ran"]): the saved cards involved, in library order,
 * how many of them each base word has, the headword to suggest keeping, and whether to merge it unless told otherwise.
 */
export interface DuplicateClusterView {
  id: string;
  baseWords: string[];
  items: StoredItem[];
  /** Cards per base word, counted by the normalized base the cluster is made of, so "don’t" counts under "don't". */
  counts: Record<string, number>;
  /**
   * The base word whose cards list every other one among their forms, else the shortest. Of several, the one with
   * the most forms built on it (runs and running on run, none on ran), then the shortest.
   */
  suggestedCanonical: string;
  /**
   * Whether the merge starts ticked: there is evidence both ways that these are one word. Every other base word is
   * among the headword's forms, lists the headword among its own, and has no form beyond the headword, the
   * headword's forms and the cluster's base words. find/found, lie/lay, saw/see and left/leave fail; ran/run passes.
   */
  defaultInclude: boolean;
  /** Each base word with the start of its best card's definition, to tell different words apart. */
  members: { base: string; definition: string }[];
  /**
   * What merging the cluster under each of its base words would do (dryRunMerge over its cards). Clusters share no
   * card, so the effects of the clusters merged together add up to the merge's.
   */
  effects: Record<string, MergeEffect>;
}

/** The start of a definition, about 60 characters, ending on a whole word. */
const definitionSnippet = (definition: string | undefined): string => {
  const text = (definition ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= DEFINITION_SNIPPET_CHARS) return text;
  const cut = text.slice(0, DEFINITION_SNIPPET_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > DEFINITION_SNIPPET_CHARS / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '')}…`;
};

/**
 * The variant-duplicate clusters (run/running/ran) among the active items, to review before merging: those
 * holding at least two cards. One pass over the items fills every cluster. Finding them changes nothing.
 */
export function findDuplicateClusterViews(activeItems: StoredItem[]): DuplicateClusterView[] {
  // findDuplicateClusters lists each cluster's base words shortest first, the alphabetically first among equals.
  const clusters = findDuplicateClusters(activeItems).map((baseWords, i) => ({
    id: `dup-${i}`,
    baseWords,
    items: [] as StoredItem[],
    counts: Object.fromEntries(baseWords.map(base => [base, 0])) as Record<string, number>,
    // Each base word's normalized forms, from every card it has, and its best card.
    forms: new Map(baseWords.map(base => [base, new Set<string>()])),
    best: new Map<string, StoredItem & { data: VocabCard }>(),
  }));
  const clusterByBase = new Map<string, (typeof clusters)[number]>();
  for (const cluster of clusters) for (const base of cluster.baseWords) clusterByBase.set(base, cluster);

  for (const item of activeItems) {
    if (!isVocabItem(item)) continue;
    const base = cardBase(item.data);
    const cluster = clusterByBase.get(base);
    if (!cluster) continue;
    cluster.items.push(item);
    cluster.counts[base] += 1;
    for (const form of splitForms(item.data.forms)) cluster.forms.get(base)?.add(form);
    const best = cluster.best.get(base);
    if (!best || mergeScore(item) > mergeScore(best)) cluster.best.set(base, item);
  }

  return clusters
    .filter(cluster => cluster.items.length >= 2)
    .map(({ id, baseWords, items, counts, forms, best }) => {
      const formsOf = (base: string) => forms.get(base) ?? new Set<string>();
      const others = (base: string) => baseWords.filter(other => other !== base);
      const builtOn = (base: string) => [...formsOf(base)].filter(form => form !== base && form.startsWith(base)).length;
      const listsTheOthers = baseWords.filter(base => others(base).every(other => formsOf(base).has(other)));
      // baseWords runs shortest first, so among equals the shortest, alphabetically first, wins.
      const suggestedCanonical = listsTheOthers.reduce<string | undefined>(
        (chosen, base) => (chosen === undefined || builtOn(base) > builtOn(chosen) ? base : chosen), undefined) ?? baseWords[0];
      const headForms = formsOf(suggestedCanonical);
      const defaultInclude = others(suggestedCanonical).every(member =>
        headForms.has(member) && formsOf(member).has(suggestedCanonical) &&
        [...formsOf(member)].every(form => form === suggestedCanonical || headForms.has(form) || baseWords.includes(form)));
      const members = baseWords.map(base => ({ base, definition: definitionSnippet(best.get(base)?.data.definition) }));
      const effects = Object.fromEntries(baseWords.map(base => [base, dryRunMerge(items, [{ baseWords, canonical: base }])]));
      return { id, baseWords, items, counts, suggestedCanonical, defaultInclude, members, effects };
    });
}
