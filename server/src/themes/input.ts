// What the theme classifier reads of one saved sentence, and the hash that says when it has to read it again.
import { createHash } from 'node:crypto';
import { stripSentenceMarkers } from '../shared/sentence-markers.js';

/**
 * One item as the classifier reads it: a saved sentence's plain text. Its kind still comes before its text in the
 * request, because the classifier's prompt was validated on items that named their kind (classifier.ts).
 */
export interface ThemeItem {
  kind: 'sentence';
  text: string;
}

/** A long sentence's opening sets its scene. */
export const MAX_SENTENCE_CHARS = 260;

const oneLine = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The classifier's input for a saved sentence, or null for any other item and for a sentence with no text to read. The
 * hash covers the sentence's text without its markers or extra spacing: marking another expression in the same sentence
 * keeps its theme instead of having it labelled again.
 */
export function themeInput(fields: { type: string; text?: unknown }): { item: ThemeItem; inputHash: string } | null {
  if (fields.type !== 'sentence') return null;
  const text = oneLine(stripSentenceMarkers(typeof fields.text === 'string' ? fields.text : ''));
  if (!text) return null;
  return { item: { kind: 'sentence', text: text.slice(0, MAX_SENTENCE_CHARS).trim() }, inputHash: sha256(text) };
}
