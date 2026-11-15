import { getItemImageUrl, isPhraseItem, type SearchResult, type SentenceData, type StoredItem, type VocabCard } from '../../types';
import type { PreloadSession } from '../../components/SessionPreload';
import { getServerImageVersion, IMAGE_IDB_MARKER } from '../../services/libraryImages';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';

// The sentences a word or phrase card reads aloud. Each reader keeps the rule it has always had; they differ in
// small ways (whether a blank example counts, whether text is trimmed), so they're named apart rather than merged.

/**
 * What example auto-play reads from a card, and how many eyes-free bands a word card has: a phrase's query, or a
 * word's first two examples, markers stripped and empty ones dropped.
 */
export const autoPlayTexts = (item: StoredItem | null): string[] => {
  if (!item) return [];
  if (isPhraseItem(item)) {
    const q = stripSentenceMarkers((item.data as SearchResult).query || '');
    return q ? [q] : [];
  }
  const ex = (item.data as VocabCard).examples;
  return (Array.isArray(ex) ? ex.slice(0, 2) : []).map(stripSentenceMarkers).filter(Boolean);
};

/** What E reads on a card: a phrase's query, or a word's first two examples, stripped, trimmed, blanks dropped. */
export const readableExamples = (item: StoredItem): string[] => {
  const ex = isPhraseItem(item)
    ? [(item.data as SearchResult).query]
    : ((item.data as VocabCard).examples || []);
  return (ex as string[]).slice(0, 2).map(s => stripSentenceMarkers(s || '').trim()).filter(Boolean);
};

/** The raw text at `index` among a card's examples (a phrase has one: its query), for Cmd/Ctrl+1–4. */
export const exampleAt = (item: StoredItem, index: number): string => {
  const ex = isPhraseItem(item)
    ? [(item.data as SearchResult).query]
    : ((item.data as VocabCard).examples || []);
  return (ex as string[])[index] || '';
};

/** A phrase's first Key Vocabulary example, stripped and trimmed. */
export const keyVocabExample = (phrase: SearchResult): string | undefined =>
  (phrase.vocabs || [])
    .flatMap(v => v.examples || [])
    .map(s => stripSentenceMarkers(s || '').trim())
    .find(Boolean);

/**
 * How many of the two eyes-free bands read something, so the guides draw only those: a phrase always reads itself
 * and gets a second band for a Key Vocabulary example; a word has one band per example, up to two.
 */
export const wordZoneBands = (item: StoredItem | null): number => {
  if (!item) return 0;
  if (isPhraseItem(item)) return keyVocabExample(item.data as SearchResult) !== undefined ? 2 : 1;
  return Math.min(2, autoPlayTexts(item).length);
};

/**
 * What a tap in eyes-free band `zone` reads: a phrase, then its first Key Vocabulary example (or the phrase
 * again); a word's first, then second example, where a single example answers both bands. Null when the word has
 * no example. The band counts readable examples but indexes the full list, as it always has.
 */
export const zoneText = (item: StoredItem, zone: 0 | 1): string | null => {
  if (isPhraseItem(item)) {
    const phrase = item.data as SearchResult;
    return zone === 0 ? phrase.query : (keyVocabExample(phrase) || phrase.query);
  }
  const count = autoPlayTexts(item).length;
  return count > 0 ? exampleAt(item, Math.min(zone, count - 1)) : null;
};

/**
 * What sentence auto-play preloads once it starts (see SessionPreload): the listed sentences in sentence review,
 * else every card's auto-play texts, and the pictures stored on the device or the server.
 */
export const preloadSession = (items: readonly StoredItem[], sentenceReview: boolean): PreloadSession => {
  const texts = sentenceReview
    ? items.map(s => (s.data as SentenceData).text || '')
    : items.flatMap(item => autoPlayTexts(item));
  const images = new Map<string, string | undefined>();
  for (const item of items) {
    const imageUrl = getItemImageUrl(item);
    const serverVersion = getServerImageVersion(imageUrl);
    if (imageUrl === IMAGE_IDB_MARKER || serverVersion !== undefined) images.set(item.data.id, serverVersion);
  }
  return { texts, images };
};
