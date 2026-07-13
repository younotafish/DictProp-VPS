import { useMemo, useCallback } from 'react';
import Fuse from 'fuse.js';
import { StoredItem, SentenceData, isSentenceItem } from '../types';
import { stripSentenceMarkers } from '../components/HighlightedSentence';

/**
 * Search over SAVED SENTENCES (StoredItem of type 'sentence'), shared by the global AI search box
 * (autocomplete dropdown) and the Sentences tab (live list filter). Entirely local — all items are
 * already in memory, so this works offline and needs no server round-trip.
 *
 * LITERAL-FIRST, like Google: a query matches sentences that actually CONTAIN every typed word
 * (accent- and case-insensitive, so "saute" finds "sauté"/"sautéed"). Fuse.js fuzzy matching is only
 * a FALLBACK for when there are zero literal matches (typos, or words not literally present) — this
 * avoids the "saute → sauce / saucer / satellite" spelling-neighbor noise that pure fuzzy produces at
 * a 0.3 threshold. Fuse also handles CJK poorly, which the literal substring pass sidesteps entirely.
 */

/** Lowercase + strip diacritics so "saute" matches "sauté"/"sautéed" and "cafe" matches "café". */
const normalize = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

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
  const q = normalize(query.trim());
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);

  // Tier 1 — literal: keep sentences whose normalized haystack contains EVERY typed word. For a
  // single word this is a plain substring match; for several words they may appear in any order (so
  // "break ice" finds "break the ice"). This is what the user expects — no spelling-neighbor noise.
  const literal = index.records.filter(r => tokens.every(t => r.norm.includes(t)));
  if (literal.length > 0) {
    // Rank: a contiguous whole-query phrase first, then earliest occurrence, then shorter (more
    // focused) sentences. (The Sentences tab re-sorts by SRS; this ordering drives the dropdown.)
    literal.sort((a, b) => {
      const ia = a.norm.indexOf(q);
      const ib = b.norm.indexOf(q);
      const pa = ia === -1 ? 1 : 0;
      const pb = ib === -1 ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (ia !== -1 && ib !== -1 && ia !== ib) return ia - ib;
      return a.text.length - b.text.length;
    });
    const out = literal.map(r => r.stored);
    return typeof limit === 'number' ? out.slice(0, limit) : out;
  }

  // Tier 2 — fuzzy fallback: only when NOTHING matched literally (a typo, or words not present as
  // typed), so fuzzy never dilutes good literal results. Here a broad net is desirable ("did you mean").
  const fuzzy = index.fuse.search(q).map(r => r.item.stored);
  return typeof limit === 'number' ? fuzzy.slice(0, limit) : fuzzy;
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
