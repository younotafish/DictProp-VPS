import React from 'react';
import { Loader2, Mic, MicOff, Search, Wand2, X } from 'lucide-react';

interface NotebookSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** A swipe to the right across the bar clears the search. */
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  isOnline: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  isSearching: boolean;
  onToggleRecording: () => void;
  onSearchWithAI: () => void;
  onClear: () => void;
}

/** The box that filters the notebook and looks a new word up with AI, with its voice, AI and clear buttons. */
export const NotebookSearchBar: React.FC<NotebookSearchBarProps> = ({
  query, onQueryChange, onKeyDown, onTouchStart, onTouchEnd, isOnline, isRecording, isTranscribing, isSearching,
  onToggleRecording, onSearchWithAI, onClear,
}) => (
  <div
    className="px-6 pb-4"
    onTouchStart={onTouchStart}
    onTouchEnd={onTouchEnd}
  >
    <div className="relative group">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors" size={16} />
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={isRecording ? "Listening..." : "Search or look up new word"}
        aria-label="Search the notebook, or look up a new word"
        className="w-full pl-10 pr-24 py-2.5 bg-white border border-slate-200 rounded-xl text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-sm"
      />
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        {/* Voice recording button */}
        {!query && !isSearching && !isTranscribing && (
          <button
            onClick={onToggleRecording}
            className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all ${
              isRecording
                ? 'text-rose-500 bg-rose-50 animate-pulse'
                : 'text-slate-400 hover:text-violet-600 hover:bg-violet-50'
            }`}
            title={isRecording ? 'Stop recording' : 'Voice search'}
            aria-label={isRecording ? 'Stop recording' : 'Voice search'}
            disabled={!isOnline}
          >
            {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
        {isTranscribing && (
          <div className="flex items-center gap-1.5 text-violet-500">
            <Loader2 className="animate-spin" size={16} />
            <span className="text-xs font-medium">Transcribing...</span>
          </div>
        )}
        {query && !isSearching && !isTranscribing && (
          <button
            onClick={onSearchWithAI}
            className="w-9 h-9 flex items-center justify-center text-violet-500 hover:text-violet-700 rounded-lg hover:bg-violet-50 transition-colors"
            title="Search with AI (Enter)"
            aria-label="Search with AI"
            disabled={!isOnline}
          >
            <Wand2 size={16} />
          </button>
        )}
        {isSearching && (
          <div className="w-9 h-9 flex items-center justify-center">
            <Loader2 className="animate-spin text-violet-500" size={16} />
          </div>
        )}
        {query && !isSearching && !isTranscribing && (
          <button
            onClick={onClear}
            className="w-9 h-9 flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
            title="Clear search"
            aria-label="Clear search"
          >
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  </div>
);
