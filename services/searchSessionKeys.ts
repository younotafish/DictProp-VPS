/**
 * Where the search keeps requests for later in sessionStorage, which lasts as long as the tab, through a reload and the
 * OAuth redirect (services/searchRecovery.ts reads and writes them). Signing out forgets them, and so does an
 * unexpected error in the search (services/auth.ts and App's error boundary around the search). Both are in the app's
 * first chunk, so this module holds no more than the two keys and the call that clears them.
 */

/** The requests still running, or whose results hadn't been seen, when the page went. */
export const PENDING_REQUESTS_KEY = 'search_pending_v1';
/** The requests whose session expired, to run after signing in again. */
export const SEARCH_RETRIES_KEY = 'dictprop_pending_search_retry';

/** Forgets every search request kept for later. */
export function clearPendingSearches(): void {
  try {
    sessionStorage.removeItem(PENDING_REQUESTS_KEY);
    sessionStorage.removeItem(SEARCH_RETRIES_KEY);
  } catch {
    /* storage unavailable */
  }
}
