import { useCallback, useRef } from 'react';
import type { StoredItem, VocabCard } from '../types';
import { analyzeInput } from '../services/api';
import { makeVocabStoredItem } from '../services/items';
import { normalizeKey } from '../services/wordMatch';

/**
 * For the card popup: a word's full set of AI senses, fetched once per session, so the popup can page through
 * the saved and the not-yet-saved meanings, and saving the sense the learner picks.
 */
export function useSenseLookup(handleSave: (item: StoredItem) => void) {
  const senseCacheRef = useRef<Map<string, VocabCard[]>>(new Map());
  const fetchSensesForWord = useCallback(async (word: string): Promise<VocabCard[]> => {
    const key = normalizeKey(word);
    if (!key) return [];
    const cached = senseCacheRef.current.get(key);
    if (cached) return cached;
    try {
      // A marked term is one expression, even when it's several words long.
      const r = await analyzeInput(word, { mode: 'batch' });
      const vocabs = Array.isArray(r?.vocabs) ? (r.vocabs as VocabCard[]) : [];
      senseCacheRef.current.set(key, vocabs);
      return vocabs;
    } catch { return []; }
  }, []);
  const saveVocabSense = useCallback((vocab: VocabCard) => {
    handleSave(makeVocabStoredItem({ ...vocab, id: vocab.id || crypto.randomUUID() }));
  }, [handleSave]);
  return { fetchSensesForWord, saveVocabSense };
}
