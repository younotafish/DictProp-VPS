import { stripSentenceMarkers } from '../components/HighlightedSentence';

/** Text identity of a saved sentence: markers stripped, NFKC-normalized, whitespace-collapsed, lowercased. */
export const normalizeSentenceIdentity = (text: string): string =>
  stripSentenceMarkers(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
