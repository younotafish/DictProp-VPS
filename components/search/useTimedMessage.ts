import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A message that clears itself `durationMs` after it's shown, or stays until cleared when shown with
 * `untilCleared`. Showing another message restarts the clock, so an earlier message's timer can't cut it short.
 */
export function useTimedMessage<T>(durationMs: number) {
  const [message, setMessage] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((next: T, options?: { untilCleared?: boolean }) => {
    setMessage(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = options?.untilCleared ? null : setTimeout(() => setMessage(null), durationMs);
  }, [durationMs]);
  const clear = useCallback(() => setMessage(null), []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { message, show, clear };
}
