import React from 'react';

/**
 * Renders an example sentence with two kinds of emphasis, driven by inline markers
 * the AI emits:
 *
 *   {{studied item}}   — the word/phrase being studied (or the variant that appears).
 *                        Emphasis only (color A). NEVER clickable — it's the current item.
 *   [[uncommon word]]  — an uncommon / C1-C2 word, idiom, or phrase worth looking up.
 *                        Emphasis (color B) AND clickable → triggers a lookup search.
 *
 * Everything else is plain, selectable text and is NOT clickable. As a fallback for
 * legacy cards/sentences (saved before the {{...}} marker existed), any literal
 * occurrence of the full `itemWord` inside a plain run is also emphasized as the item.
 */

const ITEM_CLASS = 'text-indigo-700 font-semibold bg-indigo-50 rounded px-0.5';
const LINK_CLASS =
  'text-emerald-600 font-semibold underline decoration-dotted decoration-emerald-300 cursor-pointer hover:bg-emerald-50 rounded px-0.5 transition-colors';

interface HighlightedSentenceProps {
  text: string;
  /** The studied word/phrase — emphasized as the item and matched in legacy plain text. */
  itemWord?: string;
  /** When provided, [[uncommon]] segments become clickable and call this to look the term up. */
  onSearchWord?: (term: string) => void;
}

export const HighlightedSentence: React.FC<HighlightedSentenceProps> = ({
  text,
  itemWord = '',
  onSearchWord,
}) => {
  if (!text) return null;

  const wordLower = itemWord.trim().toLowerCase();

  // Emphasize literal occurrences of the full item phrase within a plain run — covers
  // legacy data where the studied item was not wrapped in {{...}}.
  const renderPlain = (run: string, key: string): React.ReactNode => {
    if (!run) return null;
    if (!wordLower) return run;
    const escaped = wordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return run.split(new RegExp(`\\b(${escaped})\\b`, 'gi')).map((s, k) =>
      s.toLowerCase() === wordLower ? (
        <span key={`${key}-${k}`} className={ITEM_CLASS}>{s}</span>
      ) : (
        <React.Fragment key={`${key}-${k}`}>{s}</React.Fragment>
      ),
    );
  };

  // {{studied item}} and [[clickable uncommon term]]
  const markerRe = /\{\{(.+?)\}\}|\[\[(.+?)\]\]/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;

  while ((m = markerRe.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push(
        <React.Fragment key={`p${n}`}>{renderPlain(text.slice(lastIndex, m.index), `p${n}`)}</React.Fragment>,
      );
    }
    if (m[1] !== undefined) {
      // Studied item — emphasis only, never clickable.
      nodes.push(<span key={`i${n}`} className={ITEM_CLASS}>{m[1]}</span>);
    } else {
      // Uncommon term — clickable lookup (or plain emphasis when no handler is given).
      const term = m[2];
      nodes.push(
        onSearchWord ? (
          <span
            key={`l${n}`}
            role="button"
            tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSearchWord(term); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onSearchWord(term);
              }
            }}
            className={LINK_CLASS}
          >
            {term}
          </span>
        ) : (
          <span key={`l${n}`} className={LINK_CLASS}>{term}</span>
        ),
      );
    }
    lastIndex = markerRe.lastIndex;
    n++;
  }

  if (lastIndex < text.length) {
    nodes.push(<React.Fragment key={`p${n}`}>{renderPlain(text.slice(lastIndex), `p${n}`)}</React.Fragment>);
  }

  return <>{nodes}</>;
};
