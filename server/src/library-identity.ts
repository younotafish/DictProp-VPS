// How the production audit tells duplicates apart: a card by its word and sense, a phrase by its query, a saved
// sentence by its text and the card it was saved from.

/** A label lowercased and trimmed, each run of whitespace collapsed to one space. */
export const normalizeLabel = (value: unknown): string => String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');

/** A card's identity: its word and its sense. */
export const vocabSenseKey = (word: unknown, sense: unknown): string =>
  `${normalizeLabel(word)}\u0000${normalizeLabel(sense)}`;

/** A saved sentence's text, compared without its {{target}} and [[lookup]] markers. */
export const sentenceTextKey = (text: unknown): string => normalizeLabel(String(text || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^[\]]+)\]\]/g, '$1'));

/** A saved sentence's identity: its text and the card it was saved from. */
export const sentenceIdentityKey = (text: unknown, sourceWord: unknown, sourceSense: unknown): string =>
  [sentenceTextKey(text), normalizeLabel(sourceWord), normalizeLabel(sourceSense)].join('\u0000');
