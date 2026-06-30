import React from 'react';
import { StoredItem } from '../types';

/**
 * Renders an example sentence with two kinds of emphasis, driven by inline markers
 * the AI emits:
 *
 *   {{studied item}}   — the word/phrase being studied (or the variant that appears).
 *                        Emphasis only (color A). NEVER a lookup — it's the current item.
 *   [[uncommon word]]  — an uncommon / C1-C2 word, idiom, or phrase worth looking up.
 *                        Emphasis (color B) AND clickable → triggers a lookup search.
 *
 * Everything else is plain, selectable text. When `onPlayFromWord` is provided (sentence review),
 * every word becomes individually addressable: tap/click a word to play from it, and each word
 * carries a `data-word-offset` (its position in the marker-STRIPPED sentence) so a keyboard shortcut
 * can resolve the selected/caret word. As a fallback for legacy cards/sentences (saved before the
 * {{...}} marker existed), any literal occurrence of the full `itemWord` in a plain run is also
 * emphasized as the item.
 *
 * SAVED WORDS: when `findSaved` + `onOpenCard` are both provided, EVERY word/phrase the user has
 * already saved is rendered in indigo with a dotted underline; tapping it (in look-up mode) opens that
 * card's review popup. No footnote marker — the highlight itself is the affordance. This is independent
 * of the source word — the sentence is its own study item. Unsaved [[uncommon]] words stay green →
 * look-up search.
 */

const ITEM_CLASS = 'text-indigo-700 font-semibold bg-indigo-50 rounded px-0.5';
const LINK_CLASS =
  'text-emerald-600 font-semibold underline decoration-dotted decoration-emerald-300 cursor-pointer hover:bg-emerald-50 rounded px-0.5 transition-colors';
// A word you've already saved (has a card). Indigo, like the studied item, but with a dotted
// underline to read as "you own this — tap to open". Distinct from the green LINK_CLASS, which
// means specifically "unsaved → look it up".
const SAVED_CLASS =
  'text-indigo-700 font-semibold underline decoration-dotted decoration-indigo-300 cursor-pointer hover:bg-indigo-50 rounded px-0.5 transition-colors';

// Longest saved-phrase window (in words) to test when highlighting multi-word expressions in look-up mode.
const MAX_SAVED_PHRASE_WORDS = 6;

// Strip leading/trailing punctuation for a saved-phrase lookup, keeping internal apostrophes (couldn't).
const stripEdgePunct = (s: string): string => s.replace(/^[^\w']+|[^\w']+$/g, '');

/**
 * Strip the {{studied item}} and [[uncommon term]] emphasis markers, leaving plain,
 * speakable text. Used for TTS (and anywhere the raw sentence is needed without markup).
 */
export const stripSentenceMarkers = (text: string): string =>
  (text || '').replace(/\{\{(.+?)\}\}/g, '$1').replace(/\[\[(.+?)\]\]/g, '$1');

interface HighlightedSentenceProps {
  text: string;
  /** The studied word/phrase — emphasized as the item and matched in legacy plain text. */
  itemWord?: string;
  /** When provided, [[uncommon]] segments become clickable and call this to look the term up. */
  onSearchWord?: (term: string) => void;
  /** When provided, words become click/tap-to-play + carry data-word-offset, calling this with the
   *  clicked word's character offset in the STRIPPED sentence (for word-level playback seek). */
  onPlayFromWord?: (offset: number) => void;
  /** Look up whether a term is already saved → its StoredItem. Enables footnotes (with onOpenCard). */
  findSaved?: (term: string) => StoredItem | null;
  /** Open a saved item's full card (footnote number, or a saved word tapped in look-up mode). */
  onOpenCard?: (item: StoredItem) => void;
}

const HighlightedSentenceImpl: React.FC<HighlightedSentenceProps> = ({
  text,
  itemWord = '',
  onSearchWord,
  onPlayFromWord,
  findSaved,
  onOpenCard,
}) => {
  if (!text) return null;

  const wordLower = itemWord.trim().toLowerCase();
  const footnotesEnabled = !!(findSaved && onOpenCard);
  // Tokenize plain runs (split into individually-addressable words) whenever we play from words OR
  // need to footnote saved words. Look-up-only callers (e.g. word-card examples) keep the legacy path.
  const tokenize = !!onPlayFromWord || footnotesEnabled;

  const swallowSelection = () => !!window.getSelection()?.toString().trim();

  // Render one word/phrase unit. `kind` distinguishes the studied item ({{}}), an uncommon term ([[]]),
  // and plain text. A saved unit (footnotes on) becomes indigo + a footnote number that opens its card.
  const renderUnit = (
    word: string,
    off: number,
    key: string,
    kind: 'plain' | 'item' | 'uncommon',
  ): React.ReactNode => {
    const saved = footnotesEnabled ? findSaved!(word) : null;

    if (saved) {
      const cls = kind === 'item' ? ITEM_CLASS : SAVED_CLASS;
      const openCard = (e: React.SyntheticEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenCard!(saved);
      };
      // The highlight (indigo + dotted underline) is the affordance — no footnote marker. In play mode
      // tapping the word body plays from it; in look-up mode it opens the card.
      const onWordClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (swallowSelection()) return;
        if (onPlayFromWord) onPlayFromWord(off);
        else onOpenCard!(saved);
      };
      const lookupMode = !onPlayFromWord;
      return (
        <span
          key={key}
          className={cls}
          data-word-offset={tokenize ? off : undefined}
          role={lookupMode ? 'button' : undefined}
          tabIndex={lookupMode ? 0 : undefined}
          onClick={onWordClick}
          onKeyDown={lookupMode ? (e) => { if (e.key === 'Enter' || e.key === ' ') openCard(e); } : undefined}
        >
          {word}
        </span>
      );
    }

    // ── Not saved — preserve the original behaviour. Play handlers are gated on onPlayFromWord (NOT
    // on `tokenize`, which is also true in footnote-only look-up mode where there is no play callback). ──
    if (kind === 'uncommon') {
      // Single-click is a lookup ONLY when onSearchWord is given (e.g. word cards, look-up mode).
      // In play mode (onPlayFromWord, no onSearchWord) a tap plays from this word like any other.
      return (
        <span
          key={key}
          className={LINK_CLASS}
          data-word-offset={tokenize ? off : undefined}
          role={onSearchWord ? 'button' : undefined}
          tabIndex={onSearchWord ? 0 : undefined}
          onClick={
            onSearchWord
              ? (e) => { e.preventDefault(); e.stopPropagation(); onSearchWord(word); }
              : onPlayFromWord
              ? (e) => { e.stopPropagation(); if (swallowSelection()) return; onPlayFromWord(off); }
              : undefined
          }
          onKeyDown={onSearchWord ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSearchWord(word); } } : undefined}
        >
          {word}
        </span>
      );
    }

    if (kind === 'item') {
      return (
        <span
          key={key}
          className={ITEM_CLASS}
          data-word-offset={tokenize ? off : undefined}
          onClick={onPlayFromWord ? (e) => { e.stopPropagation(); if (swallowSelection()) return; onPlayFromWord(off); } : undefined}
        >
          {word}
        </span>
      );
    }

    // plain word (only reached when tokenize is on)
    const plainCls = wordLower && word.toLowerCase() === wordLower ? ITEM_CLASS : undefined;
    if (onPlayFromWord) {
      return (
        <span
          key={key}
          data-word-offset={off}
          onClick={(e) => { e.stopPropagation(); if (swallowSelection()) return; onPlayFromWord(off); }}
          className={plainCls}
        >
          {word}
        </span>
      );
    }
    return plainCls ? <span key={key} className={plainCls}>{word}</span> : <React.Fragment key={key}>{word}</React.Fragment>;
  };

  // A multi-word saved phrase (look-up mode): indigo + dotted underline; tap opens its card. Mirrors the
  // single-word saved branch of renderUnit but spans several words as one clickable unit.
  const renderSavedPhrase = (text: string, off: number, key: string, item: StoredItem): React.ReactNode => (
    <span
      key={key}
      className={SAVED_CLASS}
      data-word-offset={off}
      role="button"
      tabIndex={0}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (swallowSelection()) return; onOpenCard!(item); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenCard!(item); } }}
    >
      {text}
    </span>
  );

  // Render a plain run between markers. With tokenize on, split into words (each addressable +
  // footnote-checked); whitespace stays raw so selection/copy is intact. With tokenize off, behave
  // exactly as before (raw text + legacy whole-word itemWord emphasis).
  const renderPlain = (run: string, baseOffset: number, key: string): React.ReactNode => {
    if (!run) return null;
    if (!tokenize) {
      if (!wordLower) return run;
      const escaped = wordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return run.split(new RegExp(`\\b(${escaped})\\b`, 'gi')).map((s, k) =>
        s.toLowerCase() === wordLower ? (
          <span key={`${key}-${k}`} className={ITEM_CLASS}>{s}</span>
        ) : (
          <React.Fragment key={`${key}-${k}`}>{s}</React.Fragment>
        ),
      );
    }
    const parts = run.split(/(\s+)/).filter(p => p !== '');
    const offsets: number[] = [];
    { let acc = 0; for (const p of parts) { offsets.push(acc); acc += p.length; } }
    const isSpace = (p: string) => /^\s+$/.test(p);
    // Look-up mode (saved-lookup, no word-level playback): greedily match the LONGEST already-saved phrase
    // at each position so multi-word idioms / phrasal verbs highlight as one unit, not just single saved
    // words. Play mode keeps the per-word path so word-level audio seek stays addressable.
    const multiWord = footnotesEnabled && !onPlayFromWord;
    const nodes: React.ReactNode[] = [];
    let i = 0;
    while (i < parts.length) {
      const part = parts[i];
      if (isSpace(part)) {
        nodes.push(<React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>);
        i++;
        continue;
      }
      if (multiWord) {
        let matchedEnd = -1;
        let matchedItem: StoredItem | null = null;
        let wordsSeen = 0;
        for (let j = i; j < parts.length && wordsSeen < MAX_SAVED_PHRASE_WORDS; j++) {
          if (isSpace(parts[j])) continue;
          wordsSeen++;
          if (wordsSeen < 2) continue; // single word → renderUnit fallback handles it
          const lookup = stripEdgePunct(parts.slice(i, j + 1).join(''));
          const hit = lookup ? findSaved!(lookup) : null;
          if (hit) { matchedEnd = j; matchedItem = hit; } // keep the longest matching window
        }
        if (matchedItem) {
          const text = parts.slice(i, matchedEnd + 1).join('');
          nodes.push(renderSavedPhrase(text, baseOffset + offsets[i], `${key}-${i}`, matchedItem));
          i = matchedEnd + 1;
          continue;
        }
      }
      nodes.push(renderUnit(part, baseOffset + offsets[i], `${key}-${i}`, 'plain'));
      i++;
    }
    return nodes;
  };

  const markerRe = /\{\{(.+?)\}\}|\[\[(.+?)\]\]/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let n = 0;
  let strippedOffset = 0; // running position in the marker-stripped sentence
  let m: RegExpExecArray | null;

  while ((m = markerRe.exec(text)) !== null) {
    if (m.index > lastIndex) {
      const run = text.slice(lastIndex, m.index);
      nodes.push(<React.Fragment key={`p${n}`}>{renderPlain(run, strippedOffset, `p${n}`)}</React.Fragment>);
      strippedOffset += run.length;
    }
    if (m[1] !== undefined) {
      const inner = m[1]; // studied item
      nodes.push(renderUnit(inner, strippedOffset, `i${n}`, 'item'));
      strippedOffset += inner.length;
    } else {
      const term = m[2]; // uncommon term
      nodes.push(renderUnit(term, strippedOffset, `l${n}`, 'uncommon'));
      strippedOffset += term.length;
    }
    lastIndex = markerRe.lastIndex;
    n++;
  }

  if (lastIndex < text.length) {
    const run = text.slice(lastIndex);
    nodes.push(<React.Fragment key={`p${n}`}>{renderPlain(run, strippedOffset, `p${n}`)}</React.Fragment>);
    strippedOffset += run.length;
  }

  return <>{nodes}</>;
};

// Memoized: with stable props (text/itemWord + stable callbacks) an unchanged sentence skips its
// per-token saved-word scan when a parent re-renders for unrelated reasons. Critical for the Sentences
// list (100s of rows) and for snappy open/close of the footnote card popup — without this, toggling
// the popup re-scans every rendered sentence against the whole library.
export const HighlightedSentence = React.memo(HighlightedSentenceImpl);
