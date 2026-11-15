import React from 'react';
import { BookOpen, Search } from 'lucide-react';

interface EmptyNotebookProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Looks the submitted query up in the search sheet. */
  onSearch: (text: string) => void;
}

/** The notebook with nothing saved in it: an invitation and a box to look up the first word. */
export const EmptyNotebook: React.FC<EmptyNotebookProps> = ({ query, onQueryChange, onSearch }) => (
  <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50">
    <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
      <BookOpen size={32} className="text-indigo-300" />
    </div>
    <h3 className="text-xl font-bold text-slate-700 mb-2">Your notebook is empty</h3>
    <p className="text-sm mb-8 max-w-xs mx-auto">Search for a word or phrase to get started.</p>

    <div className="w-full max-w-sm">
      <form onSubmit={(e) => { e.preventDefault(); if (query.trim()) onSearch(query.trim()); }} className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search a word or phrase..."
          className="w-full px-4 py-3 pr-12 rounded-xl border border-slate-200 bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-base"
          autoFocus
        />
        <button type="submit" className="absolute right-3 top-1/2 -translate-y-1/2 text-indigo-500 hover:text-indigo-700">
          <Search size={20} />
        </button>
      </form>
    </div>
  </div>
);
