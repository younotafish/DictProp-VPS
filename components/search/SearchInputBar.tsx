import React from 'react';
import { Search, X, Send, BookmarkPlus, MessageSquareQuote } from 'lucide-react';
import type { SentenceData, StoredItem } from '../../types';
import { stripSentenceMarkers } from '../../services/sentenceMarkers';
import { isImeKey } from '../keyboardTarget';

interface Props {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (query: string) => void;
  /** Saved sentences matching the query; the highlighted one opens on Enter. */
  suggestions: StoredItem[];
  highlightedIndex: number;
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  suggestionsListRef: React.RefObject<HTMLDivElement | null>;
  suggestionsId: string;
  onOpenSuggestion: (idx: number) => void;
  onSubmit: () => void;
  /** The query reads as a sentence and can be saved to the Sentences list as typed. */
  canSaveSentence: boolean;
  onSaveSentence: () => void;
  readyCount: number;
  onViewResults: () => void;
  onClose: () => void;
}

/** The search box: the query, its saved-sentence suggestions, and the save, analyze, results and close buttons. */
export const SearchInputBar: React.FC<Props> = ({
  inputRef, query, setQuery, suggestions, highlightedIndex, setHighlightedIndex, suggestionsListRef, suggestionsId,
  onOpenSuggestion, onSubmit, canSaveSentence, onSaveSentence, readyCount, onViewResults, onClose,
}) => (
  <div className="fixed bottom-20 right-4 left-4 z-[56]">
    {/* Saved-sentence suggestions (fuzzy). ↑/↓ or hover to highlight; Enter/click opens the card. */}
    {suggestions.length > 0 && (
      <div className="max-w-md ml-auto mb-2 bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden fade-in">
        <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
          Saved sentences
        </div>
        <div ref={suggestionsListRef} id={suggestionsId} role="listbox" aria-label="Saved sentences" className="max-h-64 overflow-y-auto overscroll-contain">
          {suggestions.map((s, idx) => {
            const d = s.data as SentenceData;
            return (
              <button
                key={d.id}
                id={`${suggestionsId}-${idx}`}
                role="option"
                aria-selected={idx === highlightedIndex}
                tabIndex={-1}
                onClick={() => onOpenSuggestion(idx)}
                onMouseEnter={() => setHighlightedIndex(idx)}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors border-b border-slate-50 last:border-0 ${idx === highlightedIndex ? 'bg-indigo-50' : 'hover:bg-indigo-50'}`}
              >
                <MessageSquareQuote size={14} className="text-indigo-400 shrink-0 mt-0.5" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-slate-700 line-clamp-2">{stripSentenceMarkers(d.text)}</span>
                  {d.sourceWord && (
                    <span className="mt-0.5 inline-block text-[11px] text-indigo-500 font-medium">{d.sourceWord}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    )}
    <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 flex items-center gap-2 px-4 py-3 max-w-md ml-auto">
      <Search size={18} className="text-slate-400 shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setHighlightedIndex(-1); }}
        onKeyDown={e => {
          // Keys the input method is using mid-composition (the Enter that picks a pinyin candidate, the arrows
          // that move through candidates) belong to it, not to the search.
          if (isImeKey(e.nativeEvent)) return;
          // ↑/↓ move the highlight through the saved-sentence suggestions.
          if (e.key === 'ArrowDown' && suggestions.length > 0) {
            e.preventDefault();
            setHighlightedIndex(i => (i + 1) % suggestions.length);
            return;
          }
          if (e.key === 'ArrowUp' && suggestions.length > 0) {
            e.preventDefault();
            setHighlightedIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1));
            return;
          }
          if (e.key === 'Enter') {
            // A highlighted suggestion → jump to that card; otherwise run the real AI search.
            if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
              e.preventDefault();
              onOpenSuggestion(highlightedIndex);
            } else if (query.trim()) {
              e.preventDefault();
              onSubmit();
            }
          }
          // Escape (clear and close) is handled by GlobalSearch's escape layer.
        }}
        role="combobox"
        aria-label="Look up a word"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={suggestions.length > 0 ? suggestionsId : undefined}
        aria-activedescendant={suggestions[highlightedIndex] ? `${suggestionsId}-${highlightedIndex}` : undefined}
        placeholder="Look up a word..."
        className="flex-1 text-sm outline-none bg-transparent text-slate-800 placeholder:text-slate-400"
        autoComplete="off"
        autoCapitalize="off"
      />
      {canSaveSentence && (
        <button
          onClick={onSaveSentence}
          title="Save this sentence to your Sentences list"
          aria-label="Save this sentence"
          className="shrink-0 w-8 h-8 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center hover:bg-violet-200 transition-colors"
        >
          <BookmarkPlus size={15} />
        </button>
      )}
      {query.trim() && (
        <button
          onClick={onSubmit}
          title="Analyze (sentence → its uncommon expressions)"
          aria-label="Analyze"
          className="shrink-0 w-8 h-8 rounded-full bg-indigo-500 text-white flex items-center justify-center hover:bg-indigo-600 transition-colors"
        >
          <Send size={14} />
        </button>
      )}
      {readyCount > 0 && (
        <button
          onClick={onViewResults}
          aria-label={`Show ${readyCount} ${readyCount === 1 ? 'result' : 'results'}`}
          className="shrink-0 h-7 px-2.5 rounded-full bg-indigo-500 text-white text-xs font-bold flex items-center gap-1 hover:bg-indigo-600 transition-colors animate-pulse"
        >
          <Search size={12} />
          {readyCount}
        </button>
      )}
      <button
        onClick={onClose}
        aria-label="Close search"
        className="shrink-0 text-slate-400 hover:text-slate-600"
      >
        <X size={18} />
      </button>
    </div>
  </div>
);
