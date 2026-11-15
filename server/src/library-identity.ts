// How the production audit tells duplicates apart: a card by its word and sense, a phrase by its query, a saved
// sentence by its text and the card it was saved from.
import { normalizeSentenceLookup } from './sentence-lookup.js';

/** A label lowercased and trimmed, each run of whitespace collapsed to one space. */
export const normalizeLabel = (value: unknown): string => String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');

/** A card's identity: its word and its sense. */
export const vocabSenseKey = (word: unknown, sense: unknown): string =>
  `${normalizeLabel(word)}\u0000${normalizeLabel(sense)}`;

/**
 * A saved sentence's text as the server looks sentences up (sentence-lookup.ts): without its {{target}} and [[lookup]]
 * markers, NFKC-normalized and lowercased, curly quotes and long dashes folded, spacing collapsed.
 */
export const sentenceTextKey = (text: unknown): string => normalizeSentenceLookup(String(text || ''));

/** A saved sentence's identity: its text and the card it was saved from. */
export const sentenceIdentityKey = (text: unknown, sourceWord: unknown, sourceSense: unknown): string =>
  [sentenceTextKey(text), normalizeLabel(sourceWord), normalizeLabel(sourceSense)].join('\u0000');
