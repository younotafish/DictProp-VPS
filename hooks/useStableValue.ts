import { useRef } from 'react';

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

/** Holds the last value seen while `frozen` is false. */
export function useFrozenWhile<T>(value: T, frozen: boolean): T {
  const ref = useRef(value);
  if (!frozen) ref.current = value;
  return ref.current;
}
