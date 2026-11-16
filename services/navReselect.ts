import type { ViewState } from '../types';

/**
 * A tap on the tab already showing, or its number key, scrolls the tab back to its top, and at the top puts the caret
 * in the tab's search box. The tab bar decides which (reselectAction) and tells the tab through this registry rather
 * than a window event: typed, heard only by that tab's listeners (a hidden tab's effects, and so its listeners, are
 * gone), and synchronous, so a focus() inside the tap opens the phone's keyboard.
 */

/** What a reselect asks of its tab. */
export type TabReselect = 'scroll-top' | 'focus-search';

/** What a tap on a tab does. */
export type TabTapAction = 'switch' | TabReselect | 'ignore';

/** A reselect this soon after a tab switch or the previous reselect does nothing, so a double tap never raises the keyboard. */
const RESELECT_GUARD_MS = 500;

const TABS_WITH_SEARCH: ReadonlySet<ViewState> = new Set<ViewState>(['notebook', 'sentences']);

/** Whether tab `view` has a search box for a reselect at its top to focus. */
export const hasSearchBox = (view: ViewState): boolean => TABS_WITH_SEARCH.has(view);

export function reselectAction({ isCurrent, scrollTop, msSinceSwitch, msSinceReselect, hasSearch }: {
  /** The tapped tab is the one showing. */
  isCurrent: boolean;
  /** How far down the tab is scrolled, in px; 0 for a tab never scrolled. */
  scrollTop: number;
  msSinceSwitch: number;
  msSinceReselect: number;
  hasSearch: boolean;
}): TabTapAction {
  if (!isCurrent) return 'switch';
  if (msSinceSwitch < RESELECT_GUARD_MS || msSinceReselect < RESELECT_GUARD_MS) return 'ignore';
  // A pixel of rounding or rubber band still counts as the top.
  if (scrollTop > 1) return 'scroll-top';
  return hasSearch ? 'focus-search' : 'ignore';
}

/** How to scroll back up: smoothly within three screens, at once from further down or when motion is reduced. */
export const scrollBehaviorFor = (scrollTop: number, viewportHeight: number, reducedMotion: boolean): ScrollBehavior =>
  reducedMotion || scrollTop > 3 * viewportHeight ? 'auto' : 'smooth';

const listeners = new Map<ViewState, Set<(action: TabReselect) => void>>();

/** Hears tab `view`'s reselects; the returned function stops. */
export function onTabReselect(view: ViewState, listener: (action: TabReselect) => void): () => void {
  let forView = listeners.get(view);
  if (!forView) listeners.set(view, forView = new Set());
  forView.add(listener);
  return () => { forView.delete(listener); };
}

/** Tells tab `view`'s listeners of a reselect, before it returns. */
export function notifyTabReselect(view: ViewState, action: TabReselect): void {
  for (const listener of [...listeners.get(view) ?? []]) listener(action);
}
