import { startTransition, useCallback, useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';

// When the page last came back into view. One listener serves every screen that reads the time.
let resumedAt = 0;
const listeners = new Set<() => void>();
const onVisibilityChange = () => {
  if (document.visibilityState !== 'visible') return;
  resumedAt = Date.now();
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  if (listeners.size === 0) document.addEventListener('visibilitychange', onVisibilityChange);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener('visibilitychange', onVisibilityChange);
  };
};
const getResumedAt = () => resumedAt;

/**
 * The time a screen counts what's due from. It's taken again when `key` changes, when the page comes back into view
 * and when the screen's tab is shown again, so what fell due while the screen was out of sight shows as due. It
 * doesn't tick while the screen is watched, so a list ordered by it doesn't shuffle under the reader. A list should
 * key it on what the reader changes, never on the items it shows (useListClock), so that a sync doesn't move its rows
 * either.
 */
export function useNow(key: unknown): number {
  // The third argument stands in outside a browser, where the screens' tests render them to markup.
  const resumed = useSyncExternalStore(subscribe, getResumedAt, getResumedAt);
  // A tab hidden by its <Activity> loses its effects, this subscription among them, so it doesn't hear the page
  // come back into view. Its layout effects run again when it's shown, before paint, and count the showing,
  // which takes the time again.
  const [showings, countShowing] = useReducer((count: number) => count + 1, 0);
  const wasHidden = useRef(false);
  useLayoutEffect(() => {
    if (wasHidden.current) countShowing();
    return () => { wasHidden.current = true; };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key, resumed and showings are when the time is taken again
  return useMemo(() => Date.now(), [key, resumed, showings]);
}

/**
 * The clock of a list that sentences open from, which moves only when the reader changes the view, never because the
 * library changed underneath (a sync, an enrichment, a review made elsewhere), so rows hold still while they're read.
 * It's taken again when `view` changes (a filter, the settled search, the collection open), when a sentence opens
 * over the list (noteOpened: the list catches up in a transition, behind the sentence, out of sight) and, as useNow,
 * when the page or the tab is shown again. An item whose own schedule changes still moves: the list sorts it again
 * against the same clock.
 */
export function useListClock(view: unknown): { now: number; noteOpened: () => void } {
  const [openings, countOpening] = useReducer((count: number) => count + 1, 0);
  const noteOpened = useCallback(() => startTransition(() => countOpening()), []);
  const key = useMemo(() => [view, openings], [view, openings]);
  return { now: useNow(key), noteOpened };
}
