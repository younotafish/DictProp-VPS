import { getItemImageUrl, isPhraseItem, type SearchResult, type SentenceData, type StoredItem, type VocabCard } from '../../types';
import type { PreloadCard } from '../../services/audio/autoplayPreload';
import { getServerImageVersion, isLazyImageMarker } from '../../services/libraryImages';
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
 * again); a word's first, then second auto-play text, the examples its bands are counted from (wordZoneBands),
 * where a single one answers both bands. Null when the word has none.
 */
export const zoneText = (item: StoredItem, zone: 0 | 1): string | null => {
  if (isPhraseItem(item)) {
    const phrase = item.data as SearchResult;
    return zone === 0 ? phrase.query : (keyVocabExample(phrase) || phrase.query);
  }
  const texts = autoPlayTexts(item);
  return texts.length > 0 ? texts[Math.min(zone, texts.length - 1)] : null;
};

/** What the word card does about saying its word, as the card on screen or example auto-play changes. */
export type CardPronunciation = 'say' | 'handled' | 'skip';

/**
 * The word card says its word once as each card shows: never while example auto-play reads the card (which counts as
 * the card's turn), and not again for the same card, so stopping auto-play doesn't say the word it was reading over.
 * `cardKey` names the card on screen (its id, which stays when a card before it leaves the view and it moves up);
 * `lastKey` the last card whose word was said or that auto-play read.
 */
export const pronounceOnCardChange = ({ cardKey, lastKey, examplesPlaying }: {
  cardKey: string;
  lastKey: string | null;
  examplesPlaying: boolean;
}): CardPronunciation => examplesPlaying ? 'handled' : cardKey === lastKey ? 'skip' : 'say';

/**
 * The cards sentence auto-play may preload (services/audio/autoplayPreload.ts plans which): in sentence review each
 * listed sentence, with the voice it keeps; on word cards each card's auto-play texts. A card's picture comes along
 * when it's stored on the device or the server.
 */
export const preloadCards = (items: readonly StoredItem[], sentenceReview: boolean): PreloadCard[] => items.map((item) => {
  const imageUrl = getItemImageUrl(item);
  const image = isLazyImageMarker(imageUrl) ? { id: item.data.id, version: getServerImageVersion(imageUrl) } : undefined;
  if (!sentenceReview) return { id: item.data.id, texts: autoPlayTexts(item), image };
  const sentence = item.data as SentenceData;
  const text = stripSentenceMarkers(sentence.text || '').trim();
  return { id: item.data.id, texts: text ? [text] : [], preferredStyle: sentence.preferredSpeechStyle, image };
});
