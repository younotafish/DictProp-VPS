import { useCallback, useRef } from 'react';
import type { SRSData } from '../../types';
import { useTimedMessage } from '../../hooks/useTimedMessage';
import { reviewIntervalDays } from '../../services/reviewTime';
import { acceptRemember } from '../../services/reviewGestures';

/**
 * The "Remembered!" confirmation a review shows for 1.5 s, with the interval the review really schedules and the id
 * of the card it confirms, so the view shows it only while that card is on screen and moving on takes it away; and
 * the guard that keeps one gesture from reviewing an item twice (acceptRemember).
 */
export function useRememberToast() {
  const { message: toast, show } = useTimedMessage<{ id: string; intervalDays: number }>(1500);
  const lastRememberRef = useRef<{ id: string; at: number } | null>(null);

  // Whether a remember of the item `id` counts now. One that does is recorded, so the same item's next one within
  // 1.5 s doesn't, while another item's always does.
  const tryRemember = useCallback((id: string) => {
    const now = performance.now();
    if (!acceptRemember(lastRememberRef.current, id, now)) return false;
    lastRememberRef.current = { id, at: now };
    return true;
  }, []);

  // Confirms the review of the card `id` with the interval it scheduled (FSRS handles a late review itself).
  const showRemembered = useCallback((next: SRSData, now: number, id: string) => {
    show({ id, intervalDays: reviewIntervalDays(next.nextReview, now) });
  }, [show]);

  return { toast, tryRemember, showRemembered };
}
