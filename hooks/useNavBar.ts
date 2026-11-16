import { useCallback, useEffect, useRef, type UIEvent } from 'react';
import type { ViewState } from '../types';
import { hasSearchBox, notifyTabReselect, reselectAction, scrollBehaviorFor } from '../services/navReselect';
import { useLatest } from './useStableValue';

/**
 * The tab bar's behavior: it hides while a tab scrolls down and comes back on the way up, and `navigate` is a tap on a
 * tab, which switches to it or, on the tab showing, scrolls it to its top and then focuses its search box
 * (services/navReselect).
 */
export function useNavBar(currentView: ViewState, setCurrentView: (view: ViewState) => void) {
  const showNavRef = useRef(true);
  const navRef = useRef<HTMLElement>(null);
  // Per scroller: tabs keep their scroll positions, so one tab's position says nothing about another's.
  const lastScrollYs = useRef(new WeakMap<Element, number>());
  // The scroller each tab last scrolled, for a tap on that tab to scroll back up.
  const scrollers = useRef(new Map<ViewState, HTMLElement>());
  const currentViewRef = useLatest(currentView);
  // When the tab last changed and when the showing one was last tapped: a reselect soon after either does nothing.
  const lastSwitchAtRef = useRef(-Infinity);
  const lastReselectAtRef = useRef(-Infinity);
  // Until then a scroll down doesn't hide the bar: a list's own correction after a synced position reads as one.
  const settlingUntilRef = useRef(0);
  // Direct DOM mutation, so hiding the nav bar on scroll doesn't re-render App.
  const setNavShown = useCallback((shown: boolean) => {
    if (shown === showNavRef.current) return;
    showNavRef.current = shown;
    navRef.current?.classList.toggle('translate-y-full', !shown);
    navRef.current?.classList.toggle('translate-y-0', shown);
  }, []);
  const revealNav = useCallback(() => setNavShown(true), [setNavShown]);
  // The next tab has a scroll position of its own, so the bar a scroll hid on the last one comes back.
  useEffect(() => {
    lastSwitchAtRef.current = Date.now();
    revealNav();
  }, [currentView, revealNav]);

  // Hide the nav bar while scrolling down a tab, and show it again on the way back up.
  const handleScroll = useCallback((e: UIEvent<HTMLElement>) => {
    const scroller = e.currentTarget;
    scrollers.current.set(currentViewRef.current, scroller);
    const currentScrollY = scroller.scrollTop;
    const lastScrollY = lastScrollYs.current.get(scroller) ?? currentScrollY;
    let shouldShow = showNavRef.current;

    if (currentScrollY < 10) {
      shouldShow = true;
    } else if (currentScrollY > lastScrollY && currentScrollY > 100 && Date.now() >= settlingUntilRef.current) {
      shouldShow = false;
    } else if (currentScrollY < lastScrollY) {
      shouldShow = true;
    }

    setNavShown(shouldShow);
    lastScrollYs.current.set(scroller, currentScrollY);
  }, [currentViewRef, setNavShown]);

  /**
   * Takes `scroller` as the showing tab's, where it is now, without a scroll event, and shows the bar. For 400 ms a
   * scroll down doesn't hide it again, since the list's own position correction can read as one.
   */
  const syncScrollPosition = useCallback((scroller: HTMLElement) => {
    scrollers.current.set(currentViewRef.current, scroller);
    lastScrollYs.current.set(scroller, scroller.scrollTop);
    settlingUntilRef.current = Date.now() + 400;
    setNavShown(true);
  }, [currentViewRef, setNavShown]);

  /** A tap on tab `view`, or its number key. */
  const navigate = useCallback((view: ViewState) => {
    const now = Date.now();
    const isCurrent = view === currentViewRef.current;
    const recorded = scrollers.current.get(view);
    // A scroller that has left the page (the tab's list was replaced) counts as a tab at its top.
    const scroller = recorded?.isConnected ? recorded : undefined;
    const action = reselectAction({
      isCurrent,
      scrollTop: scroller?.scrollTop ?? 0,
      msSinceSwitch: now - lastSwitchAtRef.current,
      msSinceReselect: now - lastReselectAtRef.current,
      hasSearch: hasSearchBox(view),
    });
    if (isCurrent) lastReselectAtRef.current = now;
    if (action === 'switch') { setCurrentView(view); return; }
    if (action === 'ignore') return;
    if (action === 'scroll-top' && scroller) {
      const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scroller.scrollTo({ top: 0, behavior: scrollBehaviorFor(scroller.scrollTop, scroller.clientHeight, reducedMotion) });
      revealNav();
    }
    notifyTabReselect(view, action);
  }, [currentViewRef, setCurrentView, revealNav]);

  return { navRef, revealNav, handleScroll, navigate, syncScrollPosition };
}
