import { useRef } from 'react';
import type React from 'react';

/** How far a finger must travel sideways for a swipe. */
export const SWIPE_THRESHOLD_PX = 50;

/**
 * The direction of a touch that moved `dx`, `dy` pixels, if it was a swipe: more than 50 px sideways and more
 * than half again as far sideways as up or down. Null for anything else, a scroll or a tap.
 */
export const swipeDirection = (dx: number, dy: number): 'left' | 'right' | null => {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (!(absX > absY * 1.5 && absX > SWIPE_THRESHOLD_PX)) return null;
  return dx < 0 ? 'left' : 'right';
};

/**
 * Touch handlers that call `onSwipeLeft` or `onSwipeRight` for a swipe across the element. A touch that ends with
 * text selected was selecting, on iOS, so it's left alone.
 */
export function useHorizontalSwipe({ onSwipeLeft, onSwipeRight }: { onSwipeLeft?: () => void; onSwipeRight?: () => void }) {
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;

    // Check if user is selecting text - don't interfere with text selection on iOS
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      touchStart.current = null;
      return;
    }

    const direction = swipeDirection(
      e.changedTouches[0].clientX - touchStart.current.x,
      e.changedTouches[0].clientY - touchStart.current.y,
    );
    if (direction === 'left') onSwipeLeft?.();
    else if (direction === 'right') onSwipeRight?.();
    touchStart.current = null;
  };

  return { onTouchStart, onTouchEnd };
}
