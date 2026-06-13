import React from 'react';

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
 */

const ITEM_CLASS = 'text-indigo-700 font-semibold bg-indigo-50 rounded px-0.5';
const LINK_CLASS =
  'text-emerald-600 font-semibold underline decoration-dotted decoration-emerald-300 cursor-pointer hover:bg-emerald-50 rounded px-0.5 transition-colors';

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
}

export const HighlightedSentence: React.FC<HighlightedSentenceProps> = ({
  text,
  itemWord = '',
  onSearchWord,
  onPlayFromWord,
}) => {
  if (!text) return null;

  const wordLower = itemWord.trim().toLowerCase();
  const tokenize = !!onPlayFromWord;

  // Render a plain run between markers. With tokenize on, wrap each word token in a span carrying its
  // stripped-sentence offset + double-click-to-play (whitespace stays raw so selection/copy is intact).
  // With tokenize off, behave exactly as before (raw text + legacy itemWord emphasis).
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
    const nodes: React.ReactNode[] = [];
    let local = 0;
    run.split(/(\s+)/).forEach((part, k) => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        nodes.push(<React.Fragment key={`${key}-${k}`}>{part}</React.Fragment>);
      } else {
        const off = baseOffset + local;
        nodes.push(
          <span
            key={`${key}-${k}`}
            data-word-offset={off}
            onClick={(e) => { e.stopPropagation(); if (window.getSelection()?.toString().trim()) return; onPlayFromWord!(off); }}
            className={wordLower && part.toLowerCase() === wordLower ? ITEM_CLASS : undefined}
          >
            {part}
          </span>,
        );
      }
      local += part.length;
    });
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
      // Studied item — emphasis only (never a lookup), but playable.
      const inner = m[1];
      const off = strippedOffset;
      nodes.push(
        <span
          key={`i${n}`}
          className={ITEM_CLASS}
          data-word-offset={tokenize ? off : undefined}
          onClick={tokenize ? (e) => { e.stopPropagation(); if (window.getSelection()?.toString().trim()) return; onPlayFromWord!(off); } : undefined}
        >
          {inner}
        </span>,
      );
      strippedOffset += inner.length;
    } else {
      // Uncommon term — single-click is a lookup ONLY when onSearchWord is given (e.g. word cards).
      // In the sentence review (onPlayFromWord set, NO onSearchWord) it isn't a lookup: a single tap
      // plays from this word, like any other word.
      const term = m[2];
      const off = strippedOffset;
      nodes.push(
        <span
          key={`l${n}`}
          className={LINK_CLASS}
          data-word-offset={tokenize ? off : undefined}
          role={onSearchWord ? 'button' : undefined}
          tabIndex={onSearchWord ? 0 : undefined}
          onClick={
            onSearchWord
              ? (e) => { e.preventDefault(); e.stopPropagation(); onSearchWord(term); }
              : tokenize
              ? (e) => { e.stopPropagation(); if (window.getSelection()?.toString().trim()) return; onPlayFromWord!(off); }
              : undefined
          }
          onKeyDown={onSearchWord ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSearchWord(term); } } : undefined}
        >
          {term}
        </span>,
      );
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
