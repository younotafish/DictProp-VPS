import { useCallback, useEffect, useRef, useState } from 'react';
import type { SRSData } from '../../types';

/**
 * The "Remembered!" confirmation a review shows for 1.5 s, with the interval the review really schedules, and the
 * guard that keeps one gesture from reviewing twice (a touch double-tap and its synthesized dblclick both land).
 */
export function useRememberToast() {
  const [showSuccessAnim, setShowSuccessAnim] = useState(false);
  const [rememberInfo, setRememberInfo] = useState<{ intervalDays: number } | null>(null);
  const successAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (successAnimTimerRef.current) clearTimeout(successAnimTimerRef.current); }, []);
  // Guard so a remember can't fire twice from one gesture (touch double-tap + a synthesized dblclick).
  const rememberingRef = useRef(false);

  // The overlay shows the interval the review really schedules (FSRS handles a late review itself).
  const showRemembered = useCallback((next: SRSData, now: number) => {
    setRememberInfo({ intervalDays: Math.max(1, Math.round((next.nextReview - now) / 86400000)) });
    setShowSuccessAnim(true);
    if (successAnimTimerRef.current) clearTimeout(successAnimTimerRef.current);
    successAnimTimerRef.current = setTimeout(() => {
      setShowSuccessAnim(false);
      setRememberInfo(null);
      rememberingRef.current = false;
    }, 1500);
  }, []);

  return { showSuccessAnim, rememberInfo, rememberingRef, showRemembered };
}
