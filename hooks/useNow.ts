import { useMemo, useSyncExternalStore } from 'react';

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
 * The time a screen counts what's due from. It's taken again when `key` changes (the reviews it counts did)
 * and when the page comes back into view, so what fell due while the app sat in the background shows as due.
 * It doesn't tick while the page is watched, so a list ordered by it doesn't shuffle under the reader.
 */
export function useNow(key: unknown): number {
  const resumed = useSyncExternalStore(subscribe, getResumedAt);
  return useMemo(() => Date.now(), [key, resumed]);
}
