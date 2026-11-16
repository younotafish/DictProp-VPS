import React from 'react';
import { Search, Loader2 } from 'lucide-react';

interface Props {
  /** Ready results the sheet hasn't shown yet. */
  unseenCount: number;
  /** Every ready result, seen or not. */
  readyCount: number;
  /** Lookups and comparisons queued or waiting on their answer. */
  runningCount: number;
  /** Lookups are running or a sentence is being scanned. */
  isBusy: boolean;
  /** On a tab (true), or over a card or sentence view (false); see fabBottom. */
  aboveTabBar?: boolean;
  /** The status line is showing a new result, so the button doesn't signal it too: no red count, its quiet look. */
  quiet?: boolean;
  onClick: () => void;
}

/**
 * The button's offset from the bottom of the screen. On a tab it floats above the tab bar and, on Study, the grade
 * footer; over a card it sits on the card float line, clear of the lesson row (96 px on a laptop, as before). Until
 * the caller says which, it keeps bottom-24.
 */
const fabBottom = (aboveTabBar: boolean | undefined): string =>
  aboveTabBar === undefined ? 'bottom-24'
  : aboveTabBar ? 'bottom-[calc(var(--nav-h)+var(--tab-footer-h,0px)+0.5rem)]'
  : 'bottom-[var(--card-float-bottom,6rem)]';

/** The count on the button's corner, in the tone of what it counts. */
const CountBadge: React.FC<{ tone: string; count: number }> = ({ tone, count }) => (
  <span className={`absolute -top-1 -right-1 min-w-[18px] h-[18px] ${tone} text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white`}>
    {count}
  </span>
);

/**
 * The floating search button: a spinner while lookups run, and one count, without animation. Results the sheet
 * hasn't shown yet light the button up with a red count; once all are seen it goes back to its quiet look with a
 * small slate count of them. While busy, the count is the new results if any, otherwise the lookups running. Kept
 * quiet, it counts no new results: the status line has them.
 */
export const SearchFab: React.FC<Props> = ({ unseenCount: newCount, readyCount, runningCount, isBusy, aboveTabBar, quiet, onClick }) => {
  const unseenCount = quiet ? 0 : newCount;
  return (
    <button
      onClick={onClick}
      aria-label={unseenCount > 0 ? `Search (${unseenCount} new ${unseenCount === 1 ? 'result' : 'results'})`
        : isBusy ? 'Search (in progress)'
        : readyCount > 0 ? `Search (${readyCount} ${readyCount === 1 ? 'result' : 'results'})`
        : 'Search'}
      className={`fixed ${fabBottom(aboveTabBar)} right-4 z-[55] w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all duration-300
        ${unseenCount > 0 && !isBusy
          ? 'bg-indigo-500 text-white shadow-indigo-300'
          : isBusy
          ? 'bg-white/90 text-indigo-500 border border-slate-200'
          : 'bg-white/70 text-slate-500 border border-slate-200/50 opacity-60 hover:opacity-100'
        }`}
    >
      {isBusy ? <Loader2 size={20} className="animate-spin" /> : <Search size={20} />}
      {/* While a sentence is being scanned and nothing else runs, the spinner has no count. */}
      {unseenCount > 0 ? <CountBadge tone="bg-red-500" count={unseenCount} />
        : isBusy ? (runningCount > 0 && <CountBadge tone="bg-indigo-500" count={runningCount} />)
        : (readyCount > 0 && <CountBadge tone="bg-slate-400" count={readyCount} />)}
    </button>
  );
};
