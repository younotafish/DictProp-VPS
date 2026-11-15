import React from 'react';
import { StoredItem } from '../types';

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
 * WORD OFFSETS (a contract with views/DetailView.tsx and src/index.css): whenever plain runs are split
 * into words (saved-word lookup or tap-any-word mode), each marker segment and each word that can be
 * opened or looked up carries `data-word-offset`, its character index in stripSentenceMarkers(text).
 * DetailView's click, two-finger-tap and Enter handlers find the word through that attribute and play
 * from its offset, and index.css keeps those words selectable and styles the Command-hover preview.
 */

const ITEM_CLASS = 'text-indigo-700 font-semibold bg-indigo-50 rounded px-0.5';
const LINK_CLASS =
  'text-emerald-600 font-semibold underline decoration-dotted decoration-emerald-300 cursor-pointer hover:bg-emerald-50 rounded px-0.5 transition-colors';
// A word you've already saved (has a card). Indigo, like the studied item, but with a dotted
// underline to read as "you own this — tap to open". Distinct from the green LINK_CLASS, which
// means specifically "unsaved → look it up".
const SAVED_CLASS =
  'text-indigo-700 font-semibold underline decoration-dotted decoration-indigo-300 cursor-pointer hover:bg-indigo-50 rounded px-0.5 transition-colors';

// Longest saved-phrase window (in words) to test when highlighting multi-word expressions.
const MAX_SAVED_PHRASE_WORDS = 6;

// Strip leading/trailing punctuation for a saved-phrase lookup, keeping internal apostrophes (couldn't).
const stripEdgePunct = (s: string): string => s.replace(/^[^\w']+|[^\w']+$/g, '');

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

  const wordLower = itemWord.trim().toLowerCase();
  const savedLookup = !!(findSaved && onOpenCard);
  // "Tap any (unsaved) word to look it up".
  const lookupAnyWord = !!(searchAnyWord && onSearchWord);
  // Tokenize plain runs whenever words need saved-card lookup or tap-any lookup.
  // Shared display-only callers keep the legacy unsplit path.
  const tokenize = savedLookup || lookupAnyWord;

  const swallowSelection = () => !!window.getSelection()?.toString().trim();

  // Render one word/phrase unit. `kind` distinguishes the studied item ({{}}), an uncommon term ([[]]),
  // and plain text. A saved unit (saved lookup on) becomes indigo and opens its card.
  const renderUnit = (
    word: string,
    off: number,
    key: string,
    kind: 'plain' | 'item' | 'uncommon',
  ): React.ReactNode => {
    const saved = savedLookup ? findSaved!(word) : null;

    if (saved) {
      const cls = kind === 'item' ? ITEM_CLASS : SAVED_CLASS;
      const openCard = (e: React.SyntheticEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenCard!(saved);
      };
      // The highlight (indigo + dotted underline) is the affordance: tapping the word opens the card.
      const onWordClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (swallowSelection()) return;
        onOpenCard!(saved);
      };
      return (
        <span
          key={key}
          className={cls}
          data-word-offset={tokenize ? off : undefined}
          role="button"
          tabIndex={0}
          onClick={onWordClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openCard(e); }}
        >
          {word}
        </span>
      );
    }

    if (kind === 'uncommon') {
      // Single-click is a lookup ONLY when onSearchWord is given (e.g. word cards, look-up mode).
      return (
        <span
          key={key}
          className={LINK_CLASS}
          data-word-offset={tokenize ? off : undefined}
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

    if (kind === 'item') {
      // The studied word: if unsaved, looked up in tap-any-word mode; otherwise emphasis only.
      const itemTerm = lookupAnyWord ? stripEdgePunct(word) : '';
      return (
        <span
          key={key}
          className={ITEM_CLASS + (itemTerm ? ' cursor-pointer' : '')}
          data-word-offset={tokenize ? off : undefined}
          onClick={
            itemTerm
              ? (e) => { e.stopPropagation(); if (swallowSelection()) return; onSearchWord!(itemTerm); }
              : undefined
          }
        >
          {word}
        </span>
      );
    }

    // plain word (only reached when tokenize is on)
    const plainCls = wordLower && word.toLowerCase() === wordLower ? ITEM_CLASS : undefined;
    // Tap-any-word look-up: every UNSAVED plain word is a search target (saved words hit the branch
    // above; [[uncommon]] hit the uncommon branch). Kept visually plain — no persistent underline, so the
    // sentence stays readable — with a subtle hover + pointer to signal it's tappable. Edge punctuation is
    // stripped so "cat." searches "cat". Not a keyboard tab stop (a sentence has too many words for that);
    // tap/click drives it, while the highlighted [[uncommon]]/saved words stay keyboard-focusable.
    if (lookupAnyWord) {
      const term = stripEdgePunct(word);
      if (term) {
        return (
          <span
            key={key}
            data-word-offset={tokenize ? off : undefined}
            className={`cursor-pointer rounded hover:bg-slate-100 transition-colors ${plainCls ?? ''}`}
            onClick={(e) => { e.stopPropagation(); if (swallowSelection()) return; onSearchWord!(term); }}
          >
            {word}
          </span>
        );
      }
    }
    return plainCls ? <span key={key} className={plainCls}>{word}</span> : <React.Fragment key={key}>{word}</React.Fragment>;
  };

  // A multi-word saved phrase: indigo + dotted underline; tap opens its card. Mirrors the single-word
  // saved branch of renderUnit but spans several words as one clickable unit.
  const renderSavedPhrase = (text: string, off: number, key: string, item: StoredItem): React.ReactNode => (
    <span
      key={key}
      className={SAVED_CLASS}
      data-word-offset={off}
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); if (swallowSelection()) return; e.preventDefault(); onOpenCard!(item); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenCard!(item); } }}
    >
      {text}
    </span>
  );

  // Render a plain run between markers. With tokenize on, split into words (each addressable +
  // saved-checked); whitespace stays raw so selection/copy is intact. With tokenize off, behave
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
    // With saved lookup on, greedily match the LONGEST already-saved phrase at each position so
    // multi-word idioms / phrasal verbs highlight as one unit, not just single saved words.
    const multiWord = savedLookup;
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

  // The wrapper scopes an iOS selection override. Highlighted spans use role="button" for keyboard
  // access, but the app-wide button rule must not disable long-press selection inside a sentence.
  return <span className="sentence-selectable">{nodes}</span>;
};

// Memoized: with stable props (text/itemWord + stable callbacks) an unchanged sentence skips its
// per-token saved-word scan when a parent re-renders for unrelated reasons. Critical for the Sentences
// list (100s of rows) and for snappy open/close of the saved-card popup — without this, toggling
// the popup re-scans every rendered sentence against the whole library.
export const HighlightedSentence = React.memo(HighlightedSentenceImpl);
