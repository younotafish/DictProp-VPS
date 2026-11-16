import React from 'react';
import { Search, Loader2 } from 'lucide-react';

interface Props {
  readyCount: number;
  busyCount: number;
  /** Lookups are running or a sentence is being scanned. */
  isBusy: boolean;
  /** On a tab (true), or over a card or sentence view (false); see fabBottom. */
  aboveTabBar?: boolean;
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

/** The floating search button: a spinner while lookups run, a count once results are ready. */
export const SearchFab: React.FC<Props> = ({ readyCount, busyCount, isBusy, aboveTabBar, onClick }) => (
  <button
    onClick={onClick}
    aria-label={readyCount > 0
      ? `Search (${readyCount} ${readyCount === 1 ? 'result' : 'results'} ready)`
      : isBusy ? 'Search (in progress)' : 'Search'}
    className={`fixed ${fabBottom(aboveTabBar)} right-4 z-[55] w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all duration-300
      ${readyCount > 0 && !isBusy
        ? 'bg-indigo-500 text-white shadow-indigo-300'
        : isBusy
        ? 'bg-white/90 text-indigo-500 border border-slate-200'
        : 'bg-white/70 text-slate-500 border border-slate-200/50 opacity-60 hover:opacity-100'
      }`}
  >
    {isBusy && (
      <>
        <Loader2 size={20} className="animate-spin" />
        {/* Count badge — analyses in flight/queued (omitted during the pre-enqueue sentence scan) */}
        {busyCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-indigo-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
            {busyCount}
          </span>
        )}
      </>
    )}
    {!isBusy && readyCount > 0 && (
      <>
        <Search size={20} />
        {/* Pulse ring */}
        <span className="absolute inset-0 rounded-full border-2 border-indigo-400 animate-ping opacity-40" />
        {/* Count badge */}
        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white">
          {readyCount}
        </span>
      </>
    )}
    {!isBusy && readyCount === 0 && (
      <Search size={20} />
    )}
  </button>
);
