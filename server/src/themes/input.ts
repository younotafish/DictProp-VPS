// What the theme classifier reads for one saved item, and the hash that says when it has to read the item again.
import { createHash } from 'node:crypto';
import { stripSentenceMarkers } from '../shared/sentence-markers.js';

/** One item as the classifier reads it: a saved word ("word — sense — definition") or a saved sentence. */
export interface ThemeItem {
  kind: 'word' | 'sentence';
  text: string;
}

/** Enough of a definition to tell the sense apart, short enough to keep a request of thirty items small. */
export const MAX_DEFINITION_CHARS = 160;
/** A long sentence's opening sets its scene. */
export const MAX_SENTENCE_CHARS = 260;

const oneLine = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The classifier's input for a saved word or sentence, from the item's type and the fields of its data that matter,
 * or null when it has none to read. The hash covers a word with its sense label, or a sentence's text without its
 * markers, never a definition: the enrichment cycle rewrites definitions, and a rewrite of the same meaning keeps its
 * theme instead of being labelled again.
 */
export function themeInput(fields: {
  type: string;
  word?: unknown;
  sense?: unknown;
  definition?: unknown;
  text?: unknown;
}): { item: ThemeItem; inputHash: string } | null {
  if (fields.type === 'vocab') {
    const word = oneLine(fields.word);
    if (!word) return null;
    const sense = oneLine(fields.sense);
    const definition = oneLine(fields.definition).slice(0, MAX_DEFINITION_CHARS).trim();
    return {
      item: { kind: 'word', text: [word, sense, definition].filter(Boolean).join(' — ') },
      inputHash: sha256(`${word}\u0000${sense}`),
    };
  }
  if (fields.type === 'sentence') {
    const text = oneLine(stripSentenceMarkers(typeof fields.text === 'string' ? fields.text : ''));
    if (!text) return null;
    return { item: { kind: 'sentence', text: text.slice(0, MAX_SENTENCE_CHARS).trim() }, inputHash: sha256(text) };
  }
  return null;
}
