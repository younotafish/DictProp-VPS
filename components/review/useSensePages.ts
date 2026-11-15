import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StoredItem, VocabCard } from '../../types';

const senseKey = (s?: string) => (s || '').trim().toLowerCase();

// One page of the popup: a saved sense (with SRS) or an AI sense not yet in the library.
export type SensePage =
  | { kind: 'saved'; item: StoredItem; vocab: VocabCard; sense: string }
  | { kind: 'unsaved'; vocab: VocabCard; sense: string };

/**
 * The review popup's pages: every saved sense of the tapped word, then its other AI senses, fetched on open,
 * and which page shows. `onTurn` runs each time the page turns; it must keep its identity across renders.
 */
export function useSensePages(
  items: StoredItem[],
  initialId: string | undefined,
  onFetchSenses: ((word: string) => Promise<VocabCard[]>) | undefined,
  onTurn: () => void,
) {
  const word = (items[0]?.data as VocabCard)?.word || '';

  // Fetch the word's other AI senses on open (cached per session in App) so we can page saved + unsaved.
  const [aiVocabs, setAiVocabs] = useState<VocabCard[]>([]);
  const [loadingSenses, setLoadingSenses] = useState(false);
  useEffect(() => {
    if (!onFetchSenses || !word) return;
    let alive = true;
    setLoadingSenses(true);
    onFetchSenses(word)
      .then(vs => { if (alive) setAiVocabs(Array.isArray(vs) ? vs : []); })
      .catch(() => { /* offline / failed → just the saved senses */ })
      .finally(() => { if (alive) setLoadingSenses(false); });
    return () => { alive = false; };
  }, [word, onFetchSenses]);

  // Merge saved senses (with SRS) + AI senses not already saved, deduped by sense label.
  const pages = useMemo<SensePage[]>(() => {
    const seen = new Set<string>();
    const out: SensePage[] = [];
    for (const it of items) {
      const v = it.data as VocabCard;
      const s = senseKey(v.sense);
      if (!seen.has(s)) { seen.add(s); out.push({ kind: 'saved', item: it, vocab: v, sense: s }); }
    }
    for (const v of aiVocabs) {
      const s = senseKey(v.sense);
      if (!seen.has(s)) { seen.add(s); out.push({ kind: 'unsaved', vocab: v, sense: s }); }
    }
    return out;
  }, [items, aiVocabs]);

  // Track the shown sense by its label so it survives saving/refreshing (an unsaved page becoming saved
  // keeps the same sense), unlike an id which changes when a sense is saved.
  const [currentSense, setCurrentSense] = useState<string>(() => {
    const init = initialId ? items.find(i => i.data.id === initialId) : undefined;
    return senseKey((init?.data as VocabCard)?.sense ?? (items[0]?.data as VocabCard)?.sense);
  });
  const current = pages.find(p => p.sense === currentSense) ?? pages[0];
  useEffect(() => {
    if (current && current.sense !== currentSense) setCurrentSense(current.sense);
  }, [current, currentSense]);

  const count = pages.length;
  const idx = Math.max(0, pages.findIndex(p => p.sense === current?.sense));
  const goTo = useCallback((delta: number) => {
    if (count <= 1) return;
    onTurn();
    const next = pages[(((idx + delta) % count) + count) % count];
    setCurrentSense(next.sense); // the popup pronounces it in an effect, after the new sense commits, NOT here
  }, [pages, idx, count, onTurn]);
  const goPrev = useCallback(() => goTo(-1), [goTo]);
  const goNext = useCallback(() => goTo(1), [goTo]);

  return { word, current, currentSense, count, idx, goPrev, goNext, loadingSenses };
}
