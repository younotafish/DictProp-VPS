import { useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';

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
 * The time a screen counts what's due from. It's taken again when `key` changes (the reviews it counts did),
 * when the page comes back into view and when the screen's tab is shown again, so what fell due while the
 * screen was out of sight shows as due. It doesn't tick while the screen is watched, so a list ordered by it
 * doesn't shuffle under the reader.
 */
export function useNow(key: unknown): number {
  const resumed = useSyncExternalStore(subscribe, getResumedAt);
  // A tab hidden by its <Activity> loses its effects, this subscription among them, so it doesn't hear the page
  // come back into view. Its layout effects run again when it's shown, before paint, and count the showing,
  // which takes the time again.
  const [showings, countShowing] = useReducer((count: number) => count + 1, 0);
  const wasHidden = useRef(false);
  useLayoutEffect(() => {
    if (wasHidden.current) countShowing();
    return () => { wasHidden.current = true; };
  }, []);
  return useMemo(() => Date.now(), [key, resumed, showings]);
}
