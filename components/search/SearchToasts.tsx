import React from 'react';
import { X } from 'lucide-react';

/** A failure the error toast shows: its message, and the query (with its analysis mode) a tap retries. */
export interface SearchErrorToast {
  msg: string;
  query?: string;
  analyzeMode?: 'batch';
}

interface Props {
  saveToast: string | null;
  statusToast: string | null;
  error: SearchErrorToast | null;
  onRetry: (failed: SearchErrorToast) => void;
  onDismissError: () => void;
  /** On a tab (true), or over a card or sentence view (false); see errorBottom. */
  aboveTabBar?: boolean;
}

/**
 * The error toast's offset from the bottom of the screen, above the search button. On a tab it clears the tab bar
 * and, on Study, the grade footer; over a card it sits 8 px above the lesson's attach-image button. Until the caller
 * says which, it keeps bottom-44.
 */
const errorBottom = (aboveTabBar: boolean | undefined): string =>
  aboveTabBar === undefined ? 'bottom-44'
  : aboveTabBar ? 'bottom-[calc(var(--nav-h)+var(--tab-footer-h,0px)+4rem)]'
  : 'bottom-[calc(var(--card-float-bottom,6rem)+7.5rem)]';

/** The search's notices: the save confirmation, the neutral status pill and the failure toast. */
export const SearchToasts: React.FC<Props> = ({ saveToast, statusToast, error, onRetry, onDismissError, aboveTabBar }) => (
  <>
    {/* Save toast */}
    {saveToast && (
      <div role="status" aria-live="polite" className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-emerald-500 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg fade-in">
        {saveToast}
      </div>
    )}
    {/* Status toast — neutral notices (sentence scanning / found N expressions) */}
    {statusToast && (
      <div role="status" aria-live="polite" className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] max-w-[90vw] text-center bg-violet-600 text-white text-sm font-medium px-4 py-2 rounded-full shadow-lg fade-in">
        {statusToast}
      </div>
    )}
    {/* Error toast — failures surface here instead of vanishing. Tapping the message retries the failed
        query (see GlobalSearch's retryFailedSearch); the X closes the toast without retrying. */}
    {error && (
      <div
        role="alert"
        className={`fixed ${errorBottom(aboveTabBar)} right-4 z-[56] max-w-[18rem] flex bg-red-50 text-red-600 text-xs font-medium rounded-lg shadow-lg fade-in duration-200`}
      >
        <button
          onClick={() => onRetry(error)}
          className="min-w-0 flex-1 text-left pl-3 pr-1 py-2 rounded-l-lg hover:bg-red-100 transition-colors"
        >
          {error.msg}{error.query ? ' · Tap to retry' : ''}
        </button>
        <button
          onClick={onDismissError}
          aria-label="Dismiss error"
          title="Dismiss"
          className="shrink-0 flex items-center px-2.5 rounded-r-lg text-red-400 hover:text-red-600 hover:bg-red-100 transition-colors"
        >
          <X size={16} />
        </button>
      </div>
    )}
  </>
);
