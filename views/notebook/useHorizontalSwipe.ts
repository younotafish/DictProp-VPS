import { useRef } from 'react';
import type React from 'react';
import { swipeDirection } from '../../components/swipeDirection';

/**
 * Touch handlers that call `onSwipeLeft` or `onSwipeRight` for a swipe across the element: more than 50 px sideways
 * (swipeDirection). A touch that ends with text selected was selecting, on iOS, so it's left alone.
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
