import React from 'react';
import type { StoredItem } from '../types';
import { tokenizeSentence, type SentenceUnit } from '../services/sentenceTokens';

/**
 * Renders an example sentence with two kinds of emphasis, driven by inline markers
 * the AI emits:
 *
 *   {{studied item}}   — the word/phrase being studied (or the variant that appears).
 *                        Emphasis (color A). Looked up only in tap-any-word mode, or opened when saved.
 *   [[uncommon word]]  — an uncommon / C1-C2 word, idiom, or phrase worth looking up.
 *                        Emphasis (color B) AND clickable → triggers a lookup search.
 *
 * Everything else is plain, selectable text. As a fallback for legacy cards/sentences (saved before
 * the {{...}} marker existed), any literal occurrence of the full `itemWord` in a plain run is also
 * emphasized as the item.
 *
 * SAVED WORDS: when `findSaved` + `onOpenCard` are both provided, EVERY word/phrase the user has
 * already saved is rendered in indigo with a dotted underline; tapping it opens that card's review
 * popup. The highlight itself is the affordance. This is independent of the source word — the sentence
 * is its own study item. Unsaved [[uncommon]] words stay green → look-up search.
 *
 * WORD OFFSETS (a contract with sentence review's views/detail/useSentenceGestures.ts and
 * useSentencePlayback.ts, and with src/index.css): whenever plain runs are split into words (saved-word
 * lookup or tap-any-word mode), each marker segment and each word that can be opened or looked up carries
 * `data-word-offset`, its character index in stripSentenceMarkers(text). Sentence review finds the word
 * through that attribute: a click or one-finger tap (useSentenceGestures) and Enter (useSentencePlayback)
 * play from its offset, a two-finger tap looks the word up, and the blank-space taps and clicks leave words
 * alone. index.css keeps those words selectable and styles the Command-hover preview.
 *
 * How the text splits into these pieces (markers, words, saved phrases, lookup terms) is decided by
 * services/sentenceTokens.ts, which is pure and node-tested; this component maps each piece to its span.
 */

const ITEM_CLASS = 'text-indigo-700 font-semibold bg-indigo-50 rounded px-0.5';
const LINK_CLASS =
  'text-emerald-600 font-semibold underline decoration-dotted decoration-emerald-300 cursor-pointer hover:bg-emerald-50 rounded px-0.5 transition-colors';
// A word you've already saved (has a card). Indigo, like the studied item, but with a dotted
// underline to read as "you own this — tap to open". Distinct from the green LINK_CLASS, which
// means specifically "unsaved → look it up".
const SAVED_CLASS =
  'text-indigo-700 font-semibold underline decoration-dotted decoration-indigo-300 cursor-pointer hover:bg-indigo-50 rounded px-0.5 transition-colors';

interface HighlightedSentenceProps {
  text: string;
  /** The studied word/phrase — emphasized as the item and matched in legacy plain text. */
  itemWord?: string;
  /** When provided, [[uncommon]] segments become clickable and call this to look the term up. */
  onSearchWord?: (term: string) => void;
  /** Make EVERY unsaved word a lookup target (not just [[uncommon]] ones), so tapping any plain word
   *  triggers onSearchWord. Saved words still open their card; [[uncommon]] still search.
   *  Off by default so shared call sites (Sentences list, word cards) keep tapping only the highlights. */
  searchAnyWord?: boolean;
  /** Look up whether a term is already saved → its StoredItem. With onOpenCard, saved words are highlighted. */
  findSaved?: (term: string) => StoredItem | null;
  /** Open a saved item's full card (a saved word or phrase tapped in the sentence). */
  onOpenCard?: (item: StoredItem) => void;
}

const HighlightedSentenceImpl: React.FC<HighlightedSentenceProps> = ({
  text,
  itemWord = '',
  onSearchWord,
  searchAnyWord = false,
  findSaved,
  onOpenCard,
}) => {
  if (!text) return null;

  const savedLookup = !!(findSaved && onOpenCard);
  const pieces = tokenizeSentence(text, {
    itemWord,
    findSaved: savedLookup ? findSaved : undefined,
    // "Tap any (unsaved) word to look it up".
    lookupAnyWord: !!(searchAnyWord && onSearchWord),
  });

  const swallowSelection = () => !!window.getSelection()?.toString().trim();

  const renderUnit = (unit: SentenceUnit): React.ReactNode => {
    switch (unit.kind) {
      case 'text':
        return <React.Fragment key={unit.key}>{unit.text}</React.Fragment>;

      case 'emphasis':
        return <span key={unit.key} className={ITEM_CLASS}>{unit.text}</span>;

      case 'saved': {
        // The highlight (indigo + dotted underline) is the affordance: tapping the word opens the card.
        const { item } = unit;
        const openCard = (e: React.SyntheticEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenCard!(item);
        };
        const onWordClick = (e: React.MouseEvent) => {
          e.stopPropagation();
          if (swallowSelection()) return;
          onOpenCard!(item);
        };
        return (
          <span
            key={unit.key}
            className={unit.studied ? ITEM_CLASS : SAVED_CLASS}
            data-word-offset={unit.offset}
            role="button"
            tabIndex={0}
            onClick={onWordClick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openCard(e); }}
          >
            {unit.text}
          </span>
        );
      }

      case 'phrase': {
        // A multi-word saved phrase: like a saved word, but spanning several words as one clickable unit.
        const { item } = unit;
        return (
          <span
            key={unit.key}
            className={SAVED_CLASS}
            data-word-offset={unit.offset}
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); if (swallowSelection()) return; e.preventDefault(); onOpenCard!(item); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenCard!(item); } }}
          >
            {unit.text}
          </span>
        );
      }

      case 'uncommon': {
        // Single-click is a lookup ONLY when onSearchWord is given (e.g. word cards, look-up mode).
        const word = unit.text;
        return (
          <span
            key={unit.key}
            className={LINK_CLASS}
            data-word-offset={unit.offset}
            role={onSearchWord ? 'button' : undefined}
            tabIndex={onSearchWord ? 0 : undefined}
            onClick={
              onSearchWord
                ? (e) => { e.stopPropagation(); if (swallowSelection()) return; e.preventDefault(); onSearchWord(word); }
                : undefined
            }
            onKeyDown={onSearchWord ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSearchWord(word); } } : undefined}
          >
            {word}
          </span>
        );
      }

      case 'item': {
        // The studied word: if unsaved, looked up in tap-any-word mode; otherwise emphasis only.
        const { term } = unit;
        return (
          <span
            key={unit.key}
            className={ITEM_CLASS + (term ? ' cursor-pointer' : '')}
            data-word-offset={unit.offset}
            onClick={
              term
                ? (e) => { e.stopPropagation(); if (swallowSelection()) return; onSearchWord!(term); }
                : undefined
            }
          >
            {unit.text}
          </span>
        );
      }

      case 'lookup': {
        // Tap-any-word look-up: an UNSAVED plain word. Kept visually plain — no persistent underline, so the
        // sentence stays readable — with a subtle hover + pointer to signal it's tappable. Not a keyboard tab
        // stop (a sentence has too many words for that); tap/click drives it, while the highlighted
        // [[uncommon]]/saved words stay keyboard-focusable.
        const { term } = unit;
        return (
          <span
            key={unit.key}
            data-word-offset={unit.offset}
            className={`cursor-pointer rounded hover:bg-slate-100 transition-colors ${unit.studied ? ITEM_CLASS : ''}`}
            onClick={(e) => { e.stopPropagation(); if (swallowSelection()) return; onSearchWord!(term); }}
          >
            {unit.text}
          </span>
        );
      }
    }
  };

  const nodes = pieces.map(piece =>
    piece.kind === 'run'
      ? <React.Fragment key={piece.key}>{typeof piece.content === 'string' ? piece.content : piece.content.map(renderUnit)}</React.Fragment>
      : renderUnit(piece),
  );

  // The wrapper scopes an iOS selection override. Highlighted spans use role="button" for keyboard
  // access, but the app-wide button rule must not disable long-press selection inside a sentence.
  return <span className="sentence-selectable">{nodes}</span>;
};

// Memoized: with stable props (text/itemWord + stable callbacks) an unchanged sentence skips its
// per-token saved-word scan when a parent re-renders for unrelated reasons. Critical for the Sentences
// list (100s of rows) and for snappy open/close of the saved-card popup — without this, toggling
// the popup re-scans every rendered sentence against the whole library.
export const HighlightedSentence = React.memo(HighlightedSentenceImpl);
