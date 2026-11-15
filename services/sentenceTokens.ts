import type { StoredItem } from '../types';

/**
 * How a sentence's text becomes the pieces HighlightedSentence renders: its {{studied item}} and
 * [[uncommon term]] markers, the words of the plain text between them, which of those words are saved
 * (alone or as a phrase), and what each one looks up. Pure, so the rules are pinned by node tests; the
 * component only maps each piece to its span, classes and handlers.
 *
 * Offsets are character positions in the marker-stripped text (stripSentenceMarkers), the text that is
 * spoken, so a clicked word can be played from (see HighlightedSentence's WORD OFFSETS contract).
 */

/** One piece of a sentence's markup: plain text, a {{studied item}} or an [[uncommon term]]. */
export interface SentenceSegment {
  kind: 'plain' | 'item' | 'uncommon';
  /** The text shown, without its markers. */
  text: string;
  /** Where the text starts in the marker-stripped sentence. */
  offset: number;
}

// The same grammar stripSentenceMarkers removes (services/sentenceMarkers.ts), scanned in one pass.
const MARKER = /\{\{(.+?)\}\}|\[\[(.+?)\]\]/g;

/** Splits a sentence into its plain runs and marker segments, in order; plain runs are never empty. */
export function parseSentenceMarkers(text: string): SentenceSegment[] {
  const segments: SentenceSegment[] = [];
  let offset = 0;
  let lastIndex = 0;
  const push = (kind: SentenceSegment['kind'], piece: string) => {
    segments.push({ kind, text: piece, offset });
    offset += piece.length;
  };
  for (const match of text.matchAll(MARKER)) {
    if (match.index > lastIndex) push('plain', text.slice(lastIndex, match.index));
    if (match[1] !== undefined) push('item', match[1]);
    else push('uncommon', match[2]);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) push('plain', text.slice(lastIndex));
  return segments;
}

/** Strips leading and trailing punctuation, keeping internal apostrophes (couldn't), for a lookup term. */
export const stripEdgePunct = (s: string): string => s.replace(/^[^\w']+|[^\w']+$/g, '');

/** The longest saved phrase, in words, looked for in plain text. */
const MAX_SAVED_PHRASE_WORDS = 6;

/**
 * One rendered unit. `key` is its React key. `offset`, where present, is the unit's position in the
 * marker-stripped sentence; units without one aren't addressable by DetailView.
 */
export type SentenceUnit =
  /** Text shown as it is: whitespace, a word nothing acts on, or the text around an unsplit run's item match. */
  | { kind: 'text'; key: string; text: string }
  /** The studied item matched in an unmarked run (sentences saved before markers existed): emphasis only. */
  | { kind: 'emphasis'; key: string; text: string }
  /** A word, or marker segment, that is saved: opens its card. `studied` when it is the {{item}}. */
  | { kind: 'saved'; key: string; text: string; offset: number; item: StoredItem; studied: boolean }
  /** Several words that together are a saved phrase: open its card. */
  | { kind: 'phrase'; key: string; text: string; offset: number; item: StoredItem }
  /** An [[uncommon term]] that isn't saved. */
  | { kind: 'uncommon'; key: string; text: string; offset?: number }
  /** The {{studied item}}, not saved. `term` is what tapping it looks up ('' when it looks nothing up). */
  | { kind: 'item'; key: string; text: string; offset?: number; term: string }
  /** A plain word that looks `term` up when tapped (tap-any-word mode). `studied` for a legacy item match. */
  | { kind: 'lookup'; key: string; text: string; offset: number; term: string; studied: boolean };

/** A plain run (kept in its own keyed fragment), or a marker segment's single unit. */
export type SentencePiece = { kind: 'run'; key: string; content: string | SentenceUnit[] } | SentenceUnit;

export interface TokenizeOptions {
  /** The studied word or phrase, emphasized wherever it appears whole in an unmarked run. */
  itemWord: string;
  /** Finds a term's saved item. When given, saved words and phrases are found and plain runs are split. */
  findSaved?: (term: string) => StoredItem | null;
  /** Every unsaved word looks itself up (sentence review); plain runs are split. */
  lookupAnyWord: boolean;
}

/**
 * Turns a sentence into the pieces to render. Without findSaved or lookupAnyWord, plain runs stay whole
 * (only the legacy item emphasis splits them) and nothing carries an offset.
 */
export function tokenizeSentence(text: string, { itemWord, findSaved, lookupAnyWord }: TokenizeOptions): SentencePiece[] {
  const wordLower = itemWord.trim().toLowerCase();
  // Split plain runs into words whenever words need saved-card lookup or tap-any lookup.
  const tokenize = !!findSaved || lookupAnyWord;

  // One word or marker segment. A saved one opens its card, whatever its kind.
  const unitFor = (word: string, off: number, key: string, kind: SentenceSegment['kind']): SentenceUnit => {
    const saved = findSaved ? findSaved(word) : null;
    if (saved) return { kind: 'saved', key, text: word, offset: off, item: saved, studied: kind === 'item' };
    const offset = tokenize ? off : undefined;
    if (kind === 'uncommon') return { kind: 'uncommon', key, text: word, offset };
    if (kind === 'item') return { kind: 'item', key, text: word, offset, term: lookupAnyWord ? stripEdgePunct(word) : '' };
    // A plain word (runs are split only when tokenizing). Edge punctuation is stripped so "cat." looks up "cat".
    const studied = !!wordLower && word.toLowerCase() === wordLower;
    const term = lookupAnyWord ? stripEdgePunct(word) : '';
    if (term) return { kind: 'lookup', key, text: word, offset: off, term, studied };
    return studied ? { kind: 'emphasis', key, text: word } : { kind: 'text', key, text: word };
  };

  // A plain run between markers. Split into words, whitespace kept as it is so selection and copy stay
  // intact; unsplit, only the legacy whole-word item emphasis breaks it up.
  const runContent = (run: string, baseOffset: number, key: string): string | SentenceUnit[] => {
    if (!tokenize) {
      if (!wordLower) return run;
      const escaped = wordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return run.split(new RegExp(`\\b(${escaped})\\b`, 'gi')).map((s, k): SentenceUnit =>
        s.toLowerCase() === wordLower ? { kind: 'emphasis', key: `${key}-${k}`, text: s } : { kind: 'text', key: `${key}-${k}`, text: s },
      );
    }
    const parts = run.split(/(\s+)/).filter(p => p !== '');
    const offsets: number[] = [];
    { let acc = 0; for (const p of parts) { offsets.push(acc); acc += p.length; } }
    const isSpace = (p: string) => /^\s+$/.test(p);
    const units: SentenceUnit[] = [];
    let i = 0;
    while (i < parts.length) {
      const part = parts[i];
      if (isSpace(part)) {
        units.push({ kind: 'text', key: `${key}-${i}`, text: part });
        i++;
        continue;
      }
      if (findSaved) {
        // Greedily take the LONGEST saved phrase starting here, so multi-word idioms and phrasal verbs
        // highlight as one unit, not just their single saved words.
        let matchedEnd = -1;
        let matchedItem: StoredItem | null = null;
        let wordsSeen = 0;
        for (let j = i; j < parts.length && wordsSeen < MAX_SAVED_PHRASE_WORDS; j++) {
          if (isSpace(parts[j])) continue;
          wordsSeen++;
          if (wordsSeen < 2) continue; // a single word is unitFor's
          const lookup = stripEdgePunct(parts.slice(i, j + 1).join(''));
          const hit = lookup ? findSaved(lookup) : null;
          if (hit) { matchedEnd = j; matchedItem = hit; } // keep the longest matching window
        }
        if (matchedItem) {
          const phrase = parts.slice(i, matchedEnd + 1).join('');
          units.push({ kind: 'phrase', key: `${key}-${i}`, text: phrase, offset: baseOffset + offsets[i], item: matchedItem });
          i = matchedEnd + 1;
          continue;
        }
      }
      units.push(unitFor(part, baseOffset + offsets[i], `${key}-${i}`, 'plain'));
      i++;
    }
    return units;
  };

  // Keys follow the markers: the run before marker n is p{n}, the item i{n}, the uncommon term l{n}.
  let markers = 0;
  return parseSentenceMarkers(text).map((segment): SentencePiece => {
    if (segment.kind === 'plain') {
      const key = `p${markers}`;
      return { kind: 'run', key, content: runContent(segment.text, segment.offset, key) };
    }
    const key = `${segment.kind === 'item' ? 'i' : 'l'}${markers++}`;
    return unitFor(segment.text, segment.offset, key, segment.kind);
  });
}
