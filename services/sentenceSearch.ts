import { useMemo, useCallback } from 'react';
import Fuse from 'fuse.js';
import { type StoredItem, isSentenceItem } from '../types';
import { normalizeSearchText } from './searchText';
import { stripSentenceMarkers } from './sentenceMarkers';

/**
 * Search over SAVED SENTENCES (StoredItem of type 'sentence'), shared by the global AI search box
 * (autocomplete dropdown) and the Sentences tab (live list filter). Entirely local — all items are
 * already in memory, so this works offline and needs no server round-trip.
 *
 * LITERAL-FIRST, like Google: a query matches sentences where every typed word STARTS a word
 * (accent- and case-insensitive, so "saute" finds "sauté"/"sautéed", and "ice" finds "the ice" and
 * "iced" but not "nice" or "office"). Only when no sentence has that does a typed word match inside a
 * word, and Fuse.js fuzzy matching is the last FALLBACK, for zero literal matches (typos, or words not
 * literally present) — this avoids the "saute → sauce / saucer / satellite" spelling-neighbor noise
 * that pure fuzzy produces at a 0.3 threshold. Fuse also handles CJK poorly, which the literal passes
 * sidestep entirely.
 */

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
// Scripts written without spaces between words, where a word can start at any character.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

// A typed word, and whether it may match anywhere rather than only at the start of a word: it's in an
// unspaced script, or it starts with punctuation, as "-cold" in "ice-cold" does.
interface QueryToken {
  text: string;
  anywhere: boolean;
}

const queryToken = (text: string): QueryToken => ({
  text,
  anywhere: !isWordChar(text[0]) || UNSPACED_SCRIPT.test(text),
});

/** 2 if `token` is a whole word of `hay`, 1 if it only starts words ("ice" in "iced"), 0 if it starts none. */
function wordStartMatch(hay: string, token: QueryToken): 0 | 1 | 2 {
  let found: 0 | 1 = 0;
  for (let at = hay.indexOf(token.text); at !== -1; at = hay.indexOf(token.text, at + 1)) {
    if (!token.anywhere && isWordChar(hay[at - 1])) continue;
    if (!isWordChar(hay[at + token.text.length])) return 2;
    found = 1;
  }
  return found;
}

/** Where `token` first starts a word of `hay`, or -1. */
function wordStartIndex(hay: string, token: QueryToken): number {
  for (let at = hay.indexOf(token.text); at !== -1; at = hay.indexOf(token.text, at + 1)) {
    if (token.anywhere || !isWordChar(hay[at - 1])) return at;
  }
  return -1;
}

// One indexed sentence: the original item, its plain (marker-stripped) text, and a normalized haystack
// (text + source word) used for both the literal substring pass and the Fuse fallback.
interface SentenceRecord {
  stored: StoredItem;
  text: string;   // stripSentenceMarkers(data.text) — no {{…}} / [[…]] markup (used for length tiebreak)
  norm: string;   // normalizeSearchText(text + '\n' + sourceWord)
}

export interface SentenceIndex {
  /** The searchable sentences, built on first use. */
  readonly records: readonly SentenceRecord[];
  /** The fuzzy fallback over the records, built on first use. */
  readonly fuse: Fuse<SentenceRecord>;
}

// Fuse searches the normalized haystack so the fuzzy fallback is also accent-insensitive.
const FUSE_OPTIONS = {
  keys: ['norm'],
  threshold: 0.3,
  ignoreLocation: true,
  minMatchCharLength: 2,
};

/**
 * The search records (stripped text + normalized haystack) and their Fuse fallback for these sentences.
 * Both are built on first use, the records by the first search and Fuse by the first fuzzy one, so an
 * index nobody searches costs nothing: the sentence list changes on every review or listen while both
 * search boxes usually sit empty.
 */
export function buildSentenceIndex(sentenceItems: readonly StoredItem[]): SentenceIndex {
  let records: SentenceRecord[] | undefined;
  let fuse: Fuse<SentenceRecord> | undefined;
  const getRecords = () => {
    if (!records) {
      records = [];
      for (const item of sentenceItems) {
        if (!isSentenceItem(item)) continue;
        const text = stripSentenceMarkers(item.data.text || '');
        records.push({ stored: item, text, norm: normalizeSearchText(`${text}\n${item.data.sourceWord || ''}`) });
      }
    }
    return records;
  };
  return {
    get records() { return getRecords(); },
    get fuse() { return (fuse ??= new Fuse(getRecords(), FUSE_OPTIONS)); },
  };
}

const normalizeQuery = (query: string): string => normalizeSearchText(query.trim()).replace(/\s+/g, ' ');

const capped = (out: StoredItem[], limit?: number) => (typeof limit === 'number' ? out.slice(0, limit) : out);

/**
 * The literal tiers (word starts, then substrings). Returns [] for a blank query, the matches (best first,
 * capped by `limit`) when there are any, and null when nothing matches literally, which is when a caller
 * falls back to searchSentencesFuzzy.
 */
export function searchSentencesLiteral(query: string, index: SentenceIndex, limit?: number): StoredItem[] | null {
  const q = normalizeQuery(query);
  if (!q) return [];
  const tokens = q.split(' ').map(queryToken);
  const phrase = queryToken(q);

  // Tier 1 — word starts: keep sentences where EVERY typed word starts a word of the normalized
  // haystack, in any order (so "break ice" finds "break the ice"). Rank the whole query as a phrase
  // first, then sentences where more typed words are whole words ("the ice" before "iced tea"), then
  // the earliest phrase, then shorter (more focused) sentences. The Sentences tab keeps this order.
  const byWord: { record: SentenceRecord; phraseAt: number; wholeWords: number }[] = [];
  for (const record of index.records) {
    let wholeWords = 0;
    const matched = tokens.every(token => {
      const match = wordStartMatch(record.norm, token);
      if (match === 2) wholeWords++;
      return match > 0;
    });
    if (matched) byWord.push({ record, phraseAt: wordStartIndex(record.norm, phrase), wholeWords });
  }
  if (byWord.length > 0) {
    byWord.sort((a, b) =>
      (a.phraseAt === -1 ? 1 : 0) - (b.phraseAt === -1 ? 1 : 0)
      || b.wholeWords - a.wholeWords
      || (a.phraseAt !== -1 && b.phraseAt !== -1 ? a.phraseAt - b.phraseAt : 0)
      || a.record.text.length - b.record.text.length);
    return capped(byWord.map(entry => entry.record.stored), limit);
  }

  // Tier 2 — literal: keep sentences whose normalized haystack contains EVERY typed word, inside
  // words too, for a fragment like "tion" that starts no word. Still no spelling-neighbor noise.
  const literal = index.records
    .filter(r => tokens.every(t => r.norm.includes(t.text)))
    .map(record => ({ record, at: record.norm.indexOf(q) }));
  if (literal.length > 0) {
    // Rank: a contiguous whole-query phrase first, then earliest occurrence, then shorter (more
    // focused) sentences.
    literal.sort((a, b) => {
      const pa = a.at === -1 ? 1 : 0;
      const pb = b.at === -1 ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (a.at !== -1 && b.at !== -1 && a.at !== b.at) return a.at - b.at;
      return a.record.text.length - b.record.text.length;
    });
    return capped(literal.map(entry => entry.record.stored), limit);
  }
  return null;
}

/**
 * Tier 3 — the fuzzy fallback (a typo, or words not present as typed), for when nothing matched
 * literally, so fuzzy never dilutes good literal results. Here a broad net is desirable ("did you mean").
 * It scans every sentence, which is far slower than the literal tiers.
 */
export function searchSentencesFuzzy(query: string, index: SentenceIndex, limit?: number): StoredItem[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  return capped(index.fuse.search(q).map(r => r.item.stored), limit);
}

/**
 * Search the index for a query. Returns matching StoredItems (best first). `limit` caps the count for
 * the dropdown; omit it (Sentences-tab filter) to get every match.
 */
export function searchSentences(query: string, index: SentenceIndex, limit?: number): StoredItem[] {
  return searchSentencesLiteral(query, index, limit) ?? searchSentencesFuzzy(query, index, limit);
}

/**
 * Hook: memoize the index over the given sentence items (rebuilt only when they change, and built only
 * when searched), and return a stable search function. Pass the SAME memoized `sentenceItems` array
 * (e.g. App's `sentenceItems` memo) so the index isn't rebuilt on every render.
 */
export function useSentenceSearch(
  sentenceItems: StoredItem[]
): (query: string, limit?: number) => StoredItem[] {
  const index = useMemo(() => buildSentenceIndex(sentenceItems), [sentenceItems]);
  return useCallback((query: string, limit?: number) => searchSentences(query, index, limit), [index]);
}
