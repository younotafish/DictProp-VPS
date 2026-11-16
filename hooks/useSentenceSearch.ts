import { useEffect, useMemo, useState } from 'react';
import type { StoredItem } from '../types';
import { buildSentenceIndex, searchSentencesFuzzy, searchSentencesLiteral } from '../services/sentenceSearch';

/** How long typing must pause before the fuzzy tier, a scan of every sentence, runs. */
export const FUZZY_DELAY_MS = 200;

/** What a saved-sentence search shows. */
export interface SentenceSearch {
  /** The matching sentences, best first; empty while pending. */
  results: StoredItem[];
  /**
   * Nothing matched literally and the fuzzy tier hasn't answered this query yet, so it isn't known whether anything
   * matches: show "No sentences match" only when this is false.
   */
  pending: boolean;
}

/** The fuzzy tier's answer to a query, kept until the next one. */
export interface FuzzyAnswer {
  query: string;
  limit: number | undefined;
  results: StoredItem[];
}

const NO_RESULTS: StoredItem[] = [];

/**
 * What the search shows: the literal tiers' matches when there are any (a blank query has none), else the fuzzy tier's
 * answer when it answered this very query and limit, else nothing yet, pending. An answer to another query never
 * shows, so the list never belongs to what was typed before.
 */
export function sentenceSearchResults({ literal, fuzzy, query, limit }: {
  /** searchSentencesLiteral's result for the query: null when nothing matched literally. */
  literal: StoredItem[] | null;
  fuzzy: FuzzyAnswer | null;
  query: string;
  limit?: number;
}): SentenceSearch {
  if (literal) return { results: literal, pending: false };
  if (fuzzy && fuzzy.query === query && fuzzy.limit === limit) return { results: fuzzy.results, pending: false };
  return { results: NO_RESULTS, pending: true };
}

const sameItems = (a: readonly StoredItem[], b: readonly StoredItem[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * Searches the saved sentences in `items` for `query` as it is typed, with services/sentenceSearch's tiers, capped at
 * `limit` matches. The literal tiers run on every keystroke. When they find nothing, the fuzzy tier runs once typing
 * has paused for FUZZY_DELAY_MS, not on every keystroke, and the search is pending until it answers.
 *
 * Pass the same `items` array while the sentences don't change (a memo): the index is built over it, on the first
 * search, and a new array runs the search again.
 */
export function useSentenceSearch(items: readonly StoredItem[], query: string, limit?: number): SentenceSearch {
  const index = useMemo(() => buildSentenceIndex(items), [items]);
  const literal = useMemo(() => searchSentencesLiteral(query, index, limit), [index, query, limit]);
  const [fuzzy, setFuzzy] = useState<FuzzyAnswer | null>(null);

  // A literal miss schedules the fuzzy tier, and the next keystroke cancels it. A new sentence list runs it again,
  // keeping the answer to the same query on screen meanwhile; the list changes only if the matches did.
  const literalMissed = literal === null;
  useEffect(() => {
    if (!literalMissed) return;
    const timer = setTimeout(() => {
      const results = searchSentencesFuzzy(query, index, limit);
      setFuzzy(last => (last && last.query === query && last.limit === limit && sameItems(last.results, results)
        ? last
        : { query, limit, results }));
    }, FUZZY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [literalMissed, index, query, limit]);

  return useMemo(() => sentenceSearchResults({ literal, fuzzy, query, limit }), [literal, fuzzy, query, limit]);
}
