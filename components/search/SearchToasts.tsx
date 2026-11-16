import React from 'react';
import { X } from 'lucide-react';

/** What the error toast shows: a notice, or the newest failure, with how many others wait behind it. */
export interface SearchErrorToast {
  msg: string;
  /** How many other failures are shown behind this one. */
  more?: number;
  /** Besides ×: running the failure again (Retry), with every other one retrying could fix (Retry all), or editing a
   *  query the model found no entry for (Edit). */
  action?: 'retry' | 'retry-all' | 'edit';
}

const ACTION_LABELS: Record<NonNullable<SearchErrorToast['action']>, string> = { retry: 'Retry', 'retry-all': 'Retry all', edit: 'Edit' };

interface Props {
  saveToast: string | null;
  error: SearchErrorToast | null;
  onRetry: () => void;
  onEdit: () => void;
  /** × on the error toast: clears what it shows, a notice, or else every failure. */
  onDismissError: () => void;
  /** On a tab (true), or over a card or sentence view (false); see errorBottom. */
  aboveTabBar: boolean;
}

/**
 * The error toast's offset from the bottom of the screen, above the search button. On a tab it clears the tab bar
 * and, on Study, the grade footer; over a card it sits 8 px above the lesson's attach-image button.
 */
const errorBottom = (aboveTabBar: boolean): string =>
  aboveTabBar ? 'bottom-[calc(var(--nav-h)+var(--tab-footer-h,0px)+4rem)]'
  : 'bottom-[calc(var(--card-float-bottom,6rem)+7.5rem)]';

/**
 * The search's own toasts: the save confirmation, at the top so it shows above the sheet, and the failure toast. Its
 * status line lives in the app's notice stack (SearchStatusPill).
 */
export const SearchToasts: React.FC<Props> = ({ saveToast, error, onRetry, onEdit, onDismissError, aboveTabBar }) => (
  <>
    {/* Save toast */}
    {saveToast && (
      <div role="status" aria-live="polite" className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-emerald-500 text-white text-sm font-semibold px-4 py-2 rounded-full shadow-lg fade-in">
        {saveToast}
      </div>
    )}
    {/* Error toast — failures surface here instead of vanishing, above the search box's suggestions (z-[56]). Its
        action follows the newest failure (see GlobalSearch); the X clears a notice, or drops every failure without
        retrying. */}
    {error && (
      <div
        role="alert"
        className={`fixed ${errorBottom(aboveTabBar)} right-4 z-[57] max-w-[18rem] flex bg-red-50 text-red-600 text-xs font-medium rounded-lg shadow-lg fade-in duration-200`}
      >
        <p className="min-w-0 flex-1 pl-3 pr-1 py-2">
          {error.msg}{error.more ? ` +${error.more} more` : ''}
        </p>
        {error.action && (
          <button
            type="button"
            onClick={error.action === 'edit' ? onEdit : onRetry}
            className="shrink-0 px-2 font-semibold text-red-700 hover:bg-red-100 transition-colors"
          >
            {ACTION_LABELS[error.action]}
          </button>
        )}
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
