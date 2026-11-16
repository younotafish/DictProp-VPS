import { matchBaseWords, type VariantIndex } from '../services/wordMatch';

/** Which of a scan's words the notebook has already, and the counts the Text Analyzer's list heads with. */
export interface SavedWordMarks {
  /** The words, as the scan found them, that the notebook has in some form. */
  saved: Set<string>;
  /** How many words the scan found. */
  found: number;
  /** How many of them the notebook has. */
  alreadySaved: number;
}

/**
 * Marks the scan's words the notebook already has. The match is the search's (services/wordMatch, over an index of the
 * notebook's cards), so it knows a word by its other forms: 'running' is in the notebook when 'run' is.
 */
export function markSavedWords(detected: readonly { word: string }[], index: VariantIndex): SavedWordMarks {
  const saved = new Set<string>();
  let alreadySaved = 0;
  for (const { word } of detected) {
    if (matchBaseWords(word, index).size === 0) continue;
    saved.add(word);
    alreadySaved++;
  }
  return { saved, found: detected.length, alreadySaved };
}

/** What heads the list of words found: '8 found · 3 already saved', or '8 found' when the notebook has none of them. */
export const foundHeader = (found: number, alreadySaved: number): string =>
  alreadySaved > 0 ? `${found} found · ${alreadySaved} already saved` : `${found} found`;
