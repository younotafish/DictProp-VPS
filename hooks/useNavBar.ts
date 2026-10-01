import { useCallback, useEffect, useRef, type UIEvent } from 'react';
import type { ViewState } from '../types';

export function useNavBar(currentView: ViewState) {
  const showNavRef = useRef(true);
  const navRef = useRef<HTMLElement>(null);
  // Per scroller: tabs keep their scroll positions, so one tab's position says nothing about another's.
  const lastScrollYs = useRef(new WeakMap<Element, number>());
  // Direct DOM mutation, so hiding the nav bar on scroll doesn't re-render App.
  const setNavShown = useCallback((shown: boolean) => {
    if (shown === showNavRef.current) return;
    showNavRef.current = shown;
    navRef.current?.classList.toggle('translate-y-full', !shown);
    navRef.current?.classList.toggle('translate-y-0', shown);
  }, []);
  const revealNav = useCallback(() => setNavShown(true), [setNavShown]);
  // The next tab has a scroll position of its own, so the bar a scroll hid on the last one comes back.
  useEffect(revealNav, [currentView, revealNav]);

  // Hide the nav bar while scrolling down a tab, and show it again on the way back up.
  const handleScroll = useCallback((e: UIEvent<HTMLElement>) => {
    const scroller = e.currentTarget;
    const currentScrollY = scroller.scrollTop;
    const lastScrollY = lastScrollYs.current.get(scroller) ?? currentScrollY;
    let shouldShow = showNavRef.current;

    if (currentScrollY < 10) {
      shouldShow = true;
    } else if (currentScrollY > lastScrollY && currentScrollY > 100) {
      shouldShow = false;
    } else if (currentScrollY < lastScrollY) {
      shouldShow = true;
    }

    setNavShown(shouldShow);
    lastScrollYs.current.set(scroller, currentScrollY);
  }, [setNavShown]);

  return { navRef, revealNav, handleScroll };
}
