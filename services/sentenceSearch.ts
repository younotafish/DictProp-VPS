import { useMemo, useCallback } from 'react';
import Fuse from 'fuse.js';
import { StoredItem, SentenceData, isSentenceItem } from '../types';
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

/** Lowercase + strip diacritics so "saute" matches "sauté"/"sautéed" and "cafe" matches "café", and
 *  straighten curly apostrophes, which phone keyboards type, so "don’t" matches "don't". */
const normalize = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'");

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
function wordMatch(hay: string, token: QueryToken): 0 | 1 | 2 {
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
  norm: string;   // normalize(text + '\n' + sourceWord)
}

export interface SentenceIndex {
  records: SentenceRecord[];
  fuse: Fuse<SentenceRecord>;
}

/** Build the search records (stripped text + normalized haystack) and their Fuse fallback index. */
export function buildSentenceIndex(sentenceItems: StoredItem[]): SentenceIndex {
  const records: SentenceRecord[] = [];
  for (const item of sentenceItems) {
    if (!isSentenceItem(item)) continue;
    const d = item.data as SentenceData;
    const text = stripSentenceMarkers(d.text || '');
    records.push({
      stored: item,
      text,
      norm: normalize(`${text}\n${d.sourceWord || ''}`),
    });
  }
  // Fuse searches the normalized haystack so the fuzzy fallback is also accent-insensitive.
  const fuse = new Fuse(records, {
    keys: ['norm'],
    threshold: 0.3,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  return { records, fuse };
}

/**
 * Search the index for a query. Returns matching StoredItems (best first). `limit` caps the count for
 * the dropdown; omit it (Sentences-tab filter) to get every match.
 */
export function searchSentences(query: string, index: SentenceIndex, limit?: number): StoredItem[] {
  const q = normalize(query.trim()).replace(/\s+/g, ' ');
  if (!q) return [];
  const tokens = q.split(' ').map(queryToken);
  const phrase = queryToken(q);
  const capped = (out: StoredItem[]) => (typeof limit === 'number' ? out.slice(0, limit) : out);

  // Tier 1 — word starts: keep sentences where EVERY typed word starts a word of the normalized
  // haystack, in any order (so "break ice" finds "break the ice"). Rank the whole query as a phrase
  // first, then sentences where more typed words are whole words ("the ice" before "iced tea"), then
  // the earliest phrase, then shorter (more focused) sentences. The Sentences tab keeps this order.
  const byWord: { record: SentenceRecord; phraseAt: number; wholeWords: number }[] = [];
  for (const record of index.records) {
    let wholeWords = 0;
    const matched = tokens.every(token => {
      const match = wordMatch(record.norm, token);
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
    return capped(byWord.map(entry => entry.record.stored));
  }

  // Tier 2 — literal: keep sentences whose normalized haystack contains EVERY typed word, inside
  // words too, for a fragment like "tion" that starts no word. Still no spelling-neighbor noise.
  const literal = index.records.filter(r => tokens.every(t => r.norm.includes(t.text)));
  if (literal.length > 0) {
    // Rank: a contiguous whole-query phrase first, then earliest occurrence, then shorter (more
    // focused) sentences.
    literal.sort((a, b) => {
      const ia = a.norm.indexOf(q);
      const ib = b.norm.indexOf(q);
      const pa = ia === -1 ? 1 : 0;
      const pb = ib === -1 ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (ia !== -1 && ib !== -1 && ia !== ib) return ia - ib;
      return a.text.length - b.text.length;
    });
    return capped(literal.map(r => r.stored));
  }

  // Tier 3 — fuzzy fallback: only when NOTHING matched literally (a typo, or words not present as
  // typed), so fuzzy never dilutes good literal results. Here a broad net is desirable ("did you mean").
  return capped(index.fuse.search(q).map(r => r.item.stored));
}

/**
 * Hook: memoize the index over the given sentence items (rebuilt only when they change), and return a
 * stable search function. Pass the SAME memoized `sentenceItems` array (e.g. App's `sentenceItems`
 * memo) so the index isn't rebuilt on every render.
 */
export function useSentenceSearch(
  sentenceItems: StoredItem[]
): (query: string, limit?: number) => StoredItem[] {
  const index = useMemo(() => buildSentenceIndex(sentenceItems), [sentenceItems]);
  return useCallback((query: string, limit?: number) => searchSentences(query, index, limit), [index]);
}
