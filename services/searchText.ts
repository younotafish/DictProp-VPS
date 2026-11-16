/**
 * Text as a search compares it: lowercased, with accents stripped ('entrée' matches 'entree'), and curly quotes and
 * en and em dashes folded to the plain ones, since phone keyboards type them ('I’d' matches "I'd", “quote” matches
 * "quote" and 'well–known' matches 'well-known'), as a saved sentence's identity folds them
 * (services/sentenceIdentity.ts). The saved-sentence search (services/sentenceSearch.ts) and Real Life's both fold
 * text here, so a query finds the same text in each. Imports nothing, so any screen's search can use it without
 * loading another's.
 */
export const normalizeSearchText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
