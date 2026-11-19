import { useCallback, useRef } from 'react';
import type { SRSData } from '../../types';
import { useTimedMessage } from '../../hooks/useTimedMessage';
import { reviewIntervalDays } from '../../services/reviewTime';
import { acceptRemember } from '../../services/reviewGestures';
import { ownedByToday } from '../../services/sentenceOrdering';

/**
 * The interval the confirmation names for a review that leaves the schedule `next` at `now`, in whole days, or null
 * for a sentence Today owns: a Got it schedules it but leaves it Today's, and the Sentences tab rests it whatever its
 * date says (ownedByToday), so no review comes then.
 */
export const rememberedIntervalDays = (next: SRSData, now: number): number | null =>
  ownedByToday(next) ? null : reviewIntervalDays(next.nextReview, now);

/**
 * The "Remembered!" confirmation a review shows for 1.5 s, with the interval the review really schedules where one
 * applies (rememberedIntervalDays) and the id of the card it confirms, so the view shows it only while that card is on
 * screen and moving on takes it away; and the guard that keeps one gesture from reviewing an item twice
 * (acceptRemember).
 */
export function useRememberToast() {
  const { message: toast, show } = useTimedMessage<{ id: string; intervalDays: number | null }>(1500);
  const lastRememberRef = useRef<{ id: string; at: number } | null>(null);

  // Whether a remember of the item `id` counts now. One that does is recorded, so the same item's next one within
  // 1.5 s doesn't, while another item's always does.
  const tryRemember = useCallback((id: string) => {
    const now = performance.now();
    if (!acceptRemember(lastRememberRef.current, id, now)) return false;
    lastRememberRef.current = { id, at: now };
    return true;
  }, []);

  // Confirms the review of the card `id` with the interval it scheduled, where one applies (FSRS handles a late review
  // itself).
  const showRemembered = useCallback((next: SRSData, now: number, id: string) => {
    show({ id, intervalDays: rememberedIntervalDays(next, now) });
  }, [show]);

  return { toast, tryRemember, showRemembered };
}
