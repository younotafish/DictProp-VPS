import { describeSearchError, isRetryableSearchError } from '../searchRecovery';

/** Why the notebook's AI lookup failed, as its banner shows it. */
export interface NotebookSearchError {
  message: string;
  /** Sending the same lookup again could succeed: a network or provider failure, not a word the model rejected. */
  retryable: boolean;
  /** The lookup wasn't sent because the device is offline; Retry waits until it's back online. */
  offline?: true;
}

export const OFFLINE_SEARCH_MESSAGE = 'You’re offline — showing saved matches only.';

/** The banner's error for a failed lookup of `query`, worded as the search sheet words it. */
export const searchFailure = (query: string, error: unknown): NotebookSearchError => ({
  message: describeSearchError({ kind: 'analysis', label: query }, error),
  retryable: isRetryableSearchError(error),
});

/** The banner's error for a lookup asked for while offline. */
export const offlineSearchError = (): NotebookSearchError => ({ message: OFFLINE_SEARCH_MESSAGE, retryable: false, offline: true });

const comparable = (query: string): string => query.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Whether the AI card, the lookup on its way or its error still belongs to the query in the box: nothing was
 * submitted, or the box holds what was, up to case and spacing. A trailing space or a capital letter keeps a paid
 * result; any real edit drops it.
 */
export const aiCardStillValid = (submitted: string | null, current: string): boolean =>
  submitted === null || comparable(submitted) === comparable(current);

/** How far a finger drags the list, mostly up or down, before the keyboard drops. */
const BLUR_DRAG_PX = 10;

/**
 * Whether a drag on the list drops the keyboard of the focused search box: more than 10 px, mostly vertical, and not
 * started in the header, where the box and its swipe-to-clear live. A sideways swipe through a word's senses never does.
 */
export const shouldBlurOnDrag = ({ dx, dy }: { dx: number; dy: number }, startedInHeader: boolean): boolean =>
  !startedInHeader && Math.abs(dy) > BLUR_DRAG_PX && Math.abs(dy) > Math.abs(dx);

/** Whether the banner offers Retry: there's a query to retry, and retrying can work (an offline lookup once back online). */
export const retryOffered = (error: NotebookSearchError, isOnline: boolean, query: string): boolean =>
  !!query.trim() && (error.offline ? isOnline : error.retryable);
