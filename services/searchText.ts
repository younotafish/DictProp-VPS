/**
 * Text as a search compares it: lowercased, with accents stripped ('entrée' matches 'entree') and curly
 * apostrophes straightened, since phone keyboards type them ('I’d' matches "I'd"). Imports nothing, so any
 * screen's search can use it without loading another's.
 */
export const normalizeSearchText = (text: string): string =>
  text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019]/g, "'");
