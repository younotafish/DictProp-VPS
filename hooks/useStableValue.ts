import { startTransition, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Returns the previous array while every element still matches its counterpart under `same` (by default,
 * the same element), so memos keyed on the result skip changes `same` treats as irrelevant.
 */
export function useStableArray<T>(next: T[], same: (a: T, b: T) => boolean = Object.is): T[] {
  const ref = useRef(next);
  const prev = ref.current;
  if (prev !== next && (prev.length !== next.length || next.some((item, i) => !same(prev[i], item)))) {
    ref.current = next;
  }
  return ref.current;
}

/**
 * Holds the last value seen while `frozen` is false. Given `catchUpAfterMs`, a frozen value also catches up,
 * in a low-priority render, once it has gone that long without changing and the page is idle, so unfreezing
 * rarely has anything left to render.
 */
export function useFrozenWhile<T>(value: T, frozen: boolean, catchUpAfterMs?: number): T {
  const ref = useRef(value);
  const [, setCatchUps] = useState(0);
  if (!frozen) ref.current = value;
  useEffect(() => {
    if (!frozen || catchUpAfterMs === undefined || ref.current === value) return;
    let idle: number | undefined;
    const catchUp = () => startTransition(() => {
      ref.current = value;
      setCatchUps(count => count + 1);
    });
    const timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(catchUp, { timeout: 1_000 });
      else catchUp();
    }, catchUpAfterMs);
    return () => {
      window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, [value, frozen, catchUpAfterMs]);
  return ref.current;
}

/** A ref to the latest value, so a listener registered once can still call the current callbacks. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => { ref.current = value; });
  return ref;
}
