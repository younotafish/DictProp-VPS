import React from 'react';

/** Why the AI lookup or the voice search failed, with a Retry while there's a query to retry. */
export const SearchErrorBanner: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => (
  <div className="px-4 py-3 mx-3 mt-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-center justify-between gap-3">
    <span>{message}</span>
    {onRetry && (
      <button
        onClick={onRetry}
        className="px-3 py-1.5 bg-rose-100 hover:bg-rose-200 rounded-lg text-rose-700 text-xs font-semibold transition-colors shrink-0"
      >
        Retry
      </button>
    )}
  </div>
);
