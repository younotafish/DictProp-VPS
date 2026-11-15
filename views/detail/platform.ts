/**
 * The device the card view runs on. Nothing here changes while the page is open, so it's read once, when the
 * view's code loads, rather than on every render. Node, where the tests run, reports a touchless desktop.
 */

export interface Platform {
  isIOS: boolean;
  isAndroid: boolean;
  /** A phone or tablet: words take taps and two-finger taps rather than clicks. */
  isMobile: boolean;
  /** A Mac laptop or desktop, where Command-click looks a word up. */
  isMacDesktop: boolean;
  /** Taps are possible, so the eyes-free read zones are worth drawing. */
  isTouchCapable: boolean;
}

type NavigatorFacts = Pick<Navigator, 'userAgent' | 'platform'> & { maxTouchPoints?: number };

export function detectPlatform(nav: NavigatorFacts | undefined, coarsePointer: () => boolean): Platform {
  if (!nav) return { isIOS: false, isAndroid: false, isMobile: false, isMacDesktop: false, isTouchCapable: false };
  const maxTouchPoints = nav.maxTouchPoints ?? 0;
  const isIOS = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && maxTouchPoints > 1);
  const isAndroid = /Android/.test(nav.userAgent);
  const isMobile = isIOS || isAndroid;
  return {
    isIOS,
    isAndroid,
    isMobile,
    // iPadOS commonly reports MacIntel, so exclude touch devices before enabling laptop-only Command
    // interactions. Checking both fields covers current Chromium/Safari and older Firefox builds.
    isMacDesktop: !isMobile && /Mac/i.test(`${nav.platform} ${nav.userAgent}`),
    // The zones fire from touchend, so gate on touch CAPABILITY (maxTouchPoints) — NOT a pointer media query:
    // iPadOS Safari defaults to "desktop-class" browsing and then reports (any-pointer: coarse) as false even
    // though touch works, which would hide the guides on the exact device they're meant for. matchMedia is an
    // OR fallback.
    isTouchCapable: maxTouchPoints > 0 || coarsePointer(),
  };
}

export const PLATFORM = detectPlatform(
  typeof navigator === 'undefined' ? undefined : navigator,
  () => typeof window !== 'undefined' && !!window.matchMedia?.('(any-pointer: coarse)')?.matches,
);
