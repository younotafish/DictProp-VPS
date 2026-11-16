import type { SentenceData, StoredItem } from '../types';
import { stripSentenceMarkers } from './sentenceMarkers';

/**
 * Text identity of a saved sentence: markers stripped, NFKC-normalized, curly quotes and en/em dashes
 * folded to their plain forms (phone keyboards type the curly ones), whitespace collapsed, lowercased.
 * The same folds as the server's sentence lookup (normalizeSentenceLookup), so both sides agree on what
 * counts as the same sentence. Only compared in memory, never stored.
 */
export const normalizeSentenceIdentity = (text: string): string =>
  stripSentenceMarkers(text)
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * Two copies of a saved sentence say the same thing: the same id and the same text. A review or a listen changes
 * only the schedule, and an enrichment only what's beside the text, so neither tells them apart.
 */
export const sameSentenceText = (a: StoredItem, b: StoredItem): boolean =>
  a.data.id === b.data.id && (a.data as SentenceData).text === (b.data as SentenceData).text;
