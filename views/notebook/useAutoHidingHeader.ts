import { useCallback, useRef } from 'react';
import type React from 'react';

/** Within this distance of the top the header always shows. */
const HEADER_REVEAL_ZONE_PX = 50;
/** Scrolls smaller than this since the last one move nothing, so a jittery finger doesn't flick the header. */
const SCROLL_HYSTERESIS_PX = 10;
/**
 * How long after a jump the notebook made itself its scrolling keeps the header in place: the list may correct the
 * jump once it has measured the rows it landed on.
 */
const JUMP_SETTLE_MS = 400;

/**
 * Slides the notebook's sticky header away while the list scrolls down and back as it scrolls up or nears the
 * top, by class rather than state, so scrolling never re-renders the notebook. Every scroll also goes on to
 * `onScroll`.
 */
export function useAutoHidingHeader(onScroll: (e: React.UIEvent<HTMLDivElement>) => void) {
  const lastScrollY = useRef(0);
  const settlingUntil = useRef(0);
  // Hidden and shown by class, so scrolling never re-renders the notebook.
  const headerRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const currentScrollY = e.currentTarget.scrollTop;

    // Top buffer zone
    if (currentScrollY < HEADER_REVEAL_ZONE_PX) {
      headerRef.current?.classList.remove('-translate-y-full');
    } else if (Date.now() >= settlingUntil.current && Math.abs(currentScrollY - lastScrollY.current) > SCROLL_HYSTERESIS_PX) {
      headerRef.current?.classList.toggle('-translate-y-full', currentScrollY > lastScrollY.current);
    }

    lastScrollY.current = currentScrollY;
    onScroll(e);
  }, [onScroll]);

  /** Brings the header back, for a screen left with nothing to scroll it back with. */
  const showHeader = useCallback(() => headerRef.current?.classList.remove('-translate-y-full'), []);

  /**
   * Takes a jump the notebook made itself (to the top, or back to where a search began) as where the header's
   * hiding counts from, and shows the header, so the jump's own scrolling doesn't slide it away.
   */
  const syncScrollPosition = useCallback((element: Element) => {
    lastScrollY.current = element.scrollTop;
    settlingUntil.current = Date.now() + JUMP_SETTLE_MS;
    headerRef.current?.classList.remove('-translate-y-full');
  }, []);

  return { headerRef, handleScroll, showHeader, syncScrollPosition };
}
