// Imported by scripts/offline under plain node: no relative imports.
import { createHash } from 'node:crypto';

/**
 * A sentence as the example pool looks it up: {{target}} and [[lookup]] markers dropped, NFKC-normalized,
 * lowercased, curly quotes and en and em dashes folded to their ASCII forms, whitespace collapsed. Texts that differ
 * only in those ways are one sentence, with one analysis and one image.
 */
export function normalizeSentenceLookup(value: string): string {
  return String(value || '')
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^[\]]+)\]\]/g, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The SHA-256 of a sentence's lookup form: its key in sentence_enrichments. */
export function sentenceLookupHash(value: string): string {
  return createHash('sha256').update(normalizeSentenceLookup(value)).digest('hex');
}

/** The id an example sentence's enrichment goes by in bundles and reports. */
export const exampleSentenceId = (lookupHash: string): string => `example-${lookupHash.slice(0, 40)}`;

/**
 * The SHA-256 of a sentence's exact text. Exports carry it and importers compare it with the live text, so any edit
 * made after an export, even one the lookup form ignores, makes the entry stale.
 */
export const sentenceTextHash = (text: string): string => createHash('sha256').update(text).digest('hex');
