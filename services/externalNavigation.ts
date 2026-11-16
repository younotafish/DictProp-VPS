/**
 * Dispatched just before the app navigates to an outside site; useLibrarySync saves the library on it. On
 * an iPhone home-screen app, opening a link can suspend the page before visibilitychange gets to save.
 * Imports nothing, so that listener, in the app's first chunk, doesn't bring the link builders
 * (services/externalLinks.ts) and their ChatGPT prompt along.
 */
export const EXTERNAL_NAV_EVENT = 'dictprop:before-external-nav';

export function noteExternalNavigation(): void {
  window.dispatchEvent(new Event(EXTERNAL_NAV_EVENT));
}
