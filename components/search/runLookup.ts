import type { SearchResult, VocabCard } from '../../types';
import { log, warn } from '../../services/logger';

/** One AI lookup: what it asks for, and whether it's a refresh. */
export interface Lookup {
  /** The word or phrase sent to the AI. */
  query: string;
  /** 'batch': an expression taken from a sentence, analyzed as one unit rather than split into its words. */
  analyzeMode?: 'batch';
  /** A refresh re-runs the AI for a word and replaces the word's saved cards with the fresh result. */
  refresh: boolean;
}

/** What a lookup reads and changes. Everything it reads, it reads once its request settles. */
export interface LookupEffects {
  analyze: (query: string, analyzeMode?: 'batch') => Promise<SearchResult>;
  /** Whether the outcome is still this request's: once a newer request owns it, this one changes nothing. */
  isCurrent: () => boolean;
  /** The library's saved cards for a word, as the library is now. */
  savedCards: (word: string) => VocabCard[];
  /** Shows the result in the lookup's queue entry, with whatever else the caller does then. */
  showResult: (result: SearchResult) => void;
  /** Marks the lookup's queue entry as failed, with the error it failed with. */
  showFailure: (error: unknown) => void;
  /** Gets the audio of the result's example sentences ready. */
  prepareAudio: (sentences: string[]) => void;
  /** Replaces a word's saved cards with fresh ones, keeping their SRS. */
  replaceSaved?: (word: string, vocabs: VocabCard[]) => void;
}

/**
 * Runs one lookup and applies its outcome. A result is shown and its audio prepared, and a refresh replaces the
 * word's saved cards (keeping their SRS) if the word is saved when the result arrives: a card deleted during the
 * request stays deleted, and a word saved during it gets the fresh result. The fresh cards have no pictures; the
 * Mac's enrichment cycle makes them. A failure goes to showFailure with its error, for the caller to keep and word.
 * An outcome that a newer request owns changes nothing at all.
 */
export const runLookup = (lookup: Lookup, effects: LookupEffects): Promise<void> => {
  const { query, analyzeMode, refresh } = lookup;
  const superseded = () => {
    if (effects.isCurrent()) return false;
    log('🔍 Dropping the superseded result for "' + query + '"');
    return true;
  };
  return effects.analyze(query, analyzeMode).then(result => {
    if (superseded()) return;
    effects.showResult(result);
    const vocabs = result.vocabs ?? [];
    effects.prepareAudio(vocabs.flatMap(vocab => vocab.examples || []));
    if (refresh && vocabs.length > 0 && effects.savedCards(query).length > 0) effects.replaceSaved?.(query, vocabs);
  }).catch(err => {
    if (superseded()) return;
    warn('🔍 Lookup failed "' + query + '":', (err as Error | undefined)?.message);
    effects.showFailure(err);
  });
};
