import { useMemo, useCallback } from 'react';
import Fuse from 'fuse.js';
import { StoredItem, SentenceData, isSentenceItem } from '../types';
import { stripSentenceMarkers } from '../components/HighlightedSentence';

/**
 * Fuzzy search over SAVED SENTENCES (StoredItem of type 'sentence'), shared by the global AI
 * search box (autocomplete dropdown) and the Sentences tab (live list filter). Entirely local —
 * all items are already in memory, so this works offline and needs no server round-trip.
 *
 * Mirrors the Notebook's Fuse setup (views/Notebook.tsx): a forgiving, location-agnostic match,
 * plus a plain substring fallback for Chinese (Fuse's Bitap matcher handles CJK poorly).
 */

// One indexed sentence: the original item plus its plain (marker-stripped) text and source word.
interface SentenceRecord {
  stored: StoredItem;
  text: string;       // stripSentenceMarkers(data.text) — no {{…}} / [[…]] markup
  sourceWord: string;
}

export interface SentenceIndex {
  records: SentenceRecord[];
  fuse: Fuse<SentenceRecord>;
}

/** Build the search records (stripped text + source word) and their Fuse index. */
export function buildSentenceIndex(sentenceItems: StoredItem[]): SentenceIndex {
  const records: SentenceRecord[] = [];
  for (const item of sentenceItems) {
    if (!isSentenceItem(item)) continue;
    const d = item.data as SentenceData;
    records.push({
      stored: item,
      text: stripSentenceMarkers(d.text || ''),
      sourceWord: d.sourceWord || '',
    });
  }
  const fuse = new Fuse(records, {
    keys: ['text', 'sourceWord'],
    threshold: 0.3,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  return { records, fuse };
}

/**
 * Search the index for a query. Returns matching StoredItems (best first). `limit` caps the count
 * for the dropdown; omit it (Sentences-tab filter) to get every match.
 */
export function searchSentences(query: string, index: SentenceIndex, limit?: number): StoredItem[] {
  const q = query.trim();
  if (!q) return [];

  const hits = index.fuse.search(q).map(r => r.item.stored);

  // CJK fallback: Fuse's Bitap does poorly with Chinese (same reason as the Notebook search), so for
  // a query containing Chinese chars, append a plain substring pass over the text + source word.
  if (/[一-鿿]/.test(q)) {
    const seen = new Set(hits.map(i => i.data.id));
    for (const r of index.records) {
      if (seen.has(r.stored.data.id)) continue;
      if (r.text.includes(q) || r.sourceWord.includes(q)) {
        hits.push(r.stored);
        seen.add(r.stored.data.id);
      }
    }
  }

  return typeof limit === 'number' ? hits.slice(0, limit) : hits;
}

/**
 * Hook: memoize the Fuse index over the given sentence items (rebuilt only when they change),
 * and return a stable search function. Pass the SAME memoized `sentenceItems` array (e.g. App's
 * `sentenceItems` memo) so the index isn't rebuilt on every render.
 */
export function useSentenceSearch(
  sentenceItems: StoredItem[]
): (query: string, limit?: number) => StoredItem[] {
  const index = useMemo(() => buildSentenceIndex(sentenceItems), [sentenceItems]);
  return useCallback((query: string, limit?: number) => searchSentences(query, index, limit), [index]);
}
