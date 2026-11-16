import { isVocabItem, type StoredItem } from '../../types';
import { cardBase, normalizeKey } from '../wordMatch';
import { findLiteralMatches, spellingOf, withAllSenses, type SearchRank } from '../notebookList';

/**
 * How well a spelling matches a notebook search, best first. Every sense of a spelling takes the spelling's best
 * tier, and the list's sort (due and weakest first, or A–Z) orders each tier.
 */
export const SEARCH_TIER = {
  /** The spelling is the query. */
  exact: 0,
  /** A saved word the query inflects: "ran" finds the run card through its forms. */
  base: 1,
  /** The spelling starts with the query. */
  prefix: 2,
  /** A word inside the spelling starts with it: "bank" in "break the bank". */
  wordPrefix: 3,
  /** The spelling contains it. */
  contains: 4,
  /** Only the Chinese or the translation contains it. */
  otherField: 5,
  /** Only the fuzzy fallback found it, ranked in Fuse's order. */
  fuzzy: 6,
} as const;

/** Room for a fuzzy match's place in Fuse's order inside its tier. */
const TIER_SPAN = 1e6;

const WORD_SEPARATOR = /[\s\-'’]/;

/** Whether the query starts a word somewhere after the spelling's first letter. */
const startsAWordInside = (spelling: string, needle: string): boolean => {
  for (let i = spelling.indexOf(needle, 1); i > 0; i = spelling.indexOf(needle, i + 1)) {
    if (WORD_SEPARATOR.test(spelling[i - 1])) return true;
  }
  return false;
};

const spellingTier = (spelling: string, needle: string, queryKey: string): number => {
  if (normalizeKey(spelling) === queryKey) return SEARCH_TIER.exact;
  if (spelling.startsWith(needle)) return SEARCH_TIER.prefix;
  if (startsAWordInside(spelling, needle)) return SEARCH_TIER.wordPrefix;
  if (spelling.includes(needle)) return SEARCH_TIER.contains;
  return SEARCH_TIER.otherField;
};

const isBaseMatch = (item: StoredItem, bases: ReadonlySet<string>): boolean =>
  bases.size > 0 && isVocabItem(item) && bases.has(cardBase(item.data));

/**
 * What a search lists before the fuzzy fallback: the items whose word, phrase or Chinese contain the query, and the
 * saved words it inflects (`bases`, from useLibraryViews' matchSavedBases: ran -> run), every sense of each; null
 * when neither finds anything, so the caller can wait to scan fuzzily.
 */
export function findSearchCandidates(items: StoredItem[], query: string, bases: ReadonlySet<string>): StoredItem[] | null {
  const literal = findLiteralMatches(items, query);
  if (bases.size === 0 || !query.trim()) return literal;
  const baseSpellings = items.filter(item => isBaseMatch(item, bases)).map(spellingOf);
  if (baseSpellings.length === 0) return literal;
  return withAllSenses(items, [...(literal ?? []).map(spellingOf), ...baseSpellings]);
}

/**
 * Each matched spelling's rank, lowest first: its tier (SEARCH_TIER) and, for a fuzzy match, its place in Fuse's
 * `fuzzyOrder`, given when the matches came from the fuzzy fallback.
 */
export function rankSearchMatches(
  matched: StoredItem[], query: string, bases: ReadonlySet<string>, fuzzyOrder?: readonly string[],
): SearchRank {
  const ranks = new Map<string, number>();
  if (fuzzyOrder) {
    fuzzyOrder.forEach((spelling, place) => {
      if (!ranks.has(spelling)) ranks.set(spelling, SEARCH_TIER.fuzzy * TIER_SPAN + place);
    });
    return ranks;
  }
  const needle = query.trim().toLowerCase();
  const queryKey = normalizeKey(query);
  for (const item of matched) {
    const spelling = spellingOf(item);
    if (!spelling) continue;
    let rank = ranks.get(spelling);
    // The spelling's own tier, once per spelling; a sense that is a saved base the query inflects lifts it.
    if (rank === undefined) rank = spellingTier(spelling, needle, queryKey) * TIER_SPAN;
    if (rank > SEARCH_TIER.base * TIER_SPAN && isBaseMatch(item, bases)) rank = SEARCH_TIER.base * TIER_SPAN;
    ranks.set(spelling, rank);
  }
  return ranks;
}
