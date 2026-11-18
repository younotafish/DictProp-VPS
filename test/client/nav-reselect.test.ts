import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type UIEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useNavBar } from '../../hooks/useNavBar.ts';
import { hasSearchBox, notifyTabReselect, onTabReselect, reselectAction, scrollBehaviorFor, type TabReselect } from '../../services/navReselect.ts';
import type { ViewState } from '../../types.ts';

// services/navReselect.ts: what a tap on a tab does, and the registry that tells the tab; then hooks/useNavBar.ts,
// which applies it.

const tap = (fields: Partial<Parameters<typeof reselectAction>[0]> = {}) => reselectAction({
  isCurrent: true, scrollTop: 0, msSinceSwitch: 10_000, msSinceReselect: 10_000, hasSearch: true, ...fields,
});

test('a tap on another tab switches to it, however soon after the last tap', () => {
  assert.equal(tap({ isCurrent: false }), 'switch');
  assert.equal(tap({ isCurrent: false, msSinceSwitch: 100, msSinceReselect: 100 }), 'switch');
});

test('a tap on the tab showing scrolls it up, and at its top focuses its search box', () => {
  assert.equal(tap({ scrollTop: 400 }), 'scroll-top');
  assert.equal(tap({ scrollTop: 0 }), 'focus-search');
  assert.equal(tap({ scrollTop: 1 }), 'focus-search', 'a pixel off still counts as the top');
  assert.equal(tap({ scrollTop: 0, hasSearch: false }), 'ignore', 'Today, Real Life and Essays have no search box');
  assert.equal(tap({ scrollTop: 400, hasSearch: false }), 'scroll-top');
});

test('a reselect within 500 ms of a tab switch or of the last reselect does nothing', () => {
  assert.equal(tap({ msSinceSwitch: 300 }), 'ignore');
  assert.equal(tap({ msSinceReselect: 300, scrollTop: 400 }), 'ignore');
  assert.equal(tap({ msSinceSwitch: 500, msSinceReselect: 500 }), 'focus-search');
});

test('only the Notebook and Sentences tabs have a search box', () => {
  const tabs: ViewState[] = ['notebook', 'sentences', 'study', 'real-life', 'essays'];
  assert.deepEqual(tabs.filter(hasSearchBox), ['notebook', 'sentences']);
});

test('the way back up is smooth within three screens, and instant beyond them or with reduced motion', () => {
  assert.equal(scrollBehaviorFor(1_600, 800, false), 'smooth');
  assert.equal(scrollBehaviorFor(2_400, 800, false), 'smooth');
  assert.equal(scrollBehaviorFor(3_200, 800, false), 'auto');
  assert.equal(scrollBehaviorFor(400, 800, true), 'auto');
});

test('a reselect reaches only its own tab\'s listeners, at once, until they stop', () => {
  const heard: string[] = [];
  const stopNotebook = onTabReselect('notebook', action => heard.push(`notebook ${action}`));
  const stopSentences = onTabReselect('sentences', action => heard.push(`sentences ${action}`));
  notifyTabReselect('notebook', 'scroll-top');
  assert.deepEqual(heard, ['notebook scroll-top'], 'heard before notifyTabReselect returned');
  notifyTabReselect('sentences', 'focus-search');
  assert.deepEqual(heard, ['notebook scroll-top', 'sentences focus-search']);
  stopNotebook();
  notifyTabReselect('notebook', 'focus-search');
  notifyTabReselect('study', 'scroll-top');
  assert.equal(heard.length, 2);
  stopSentences();
});

/** A tab's scroll container, as far as useNavBar reads it. */
function fakeScroller(scrollTop: number) {
  const scrolls: ScrollToOptions[] = [];
  const scroller = {
    isConnected: true,
    scrollTop,
    clientHeight: 800,
    scrollTo(options: ScrollToOptions) { scrolls.push(options); this.scrollTop = options.top ?? this.scrollTop; },
  };
  return { scroller, scrolls, event: { currentTarget: scroller } as unknown as UIEvent<HTMLElement> };
}

/** useNavBar on tab `view`, run once through a server render; its callbacks keep working afterwards. */
function renderNavBar(view: ViewState) {
  const switches: ViewState[] = [];
  let navBar: ReturnType<typeof useNavBar> | undefined;
  const Probe = () => { navBar = useNavBar(view, next => switches.push(next)); return null; };
  renderToStaticMarkup(createElement(Probe));
  return { navBar: navBar!, switches };
}

test('the tab bar switches tabs, and on the tab showing scrolls it up, then asks it to focus its search', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) };
  const heard: TabReselect[] = [];
  const stop = onTabReselect('notebook', action => heard.push(action));
  const { navBar, switches } = renderNavBar('notebook');

  navBar.navigate('study');
  assert.deepEqual(switches, ['study']);

  const { scroller, scrolls, event } = fakeScroller(4_000);
  navBar.handleScroll(event);
  navBar.navigate('notebook');
  assert.deepEqual(scrolls, [{ top: 0, behavior: 'auto' }], 'from five screens down, at once');
  assert.deepEqual(heard, ['scroll-top']);
  assert.equal(scroller.scrollTop, 0);

  t.mock.timers.tick(499);
  navBar.navigate('notebook');
  assert.deepEqual(heard, ['scroll-top'], 'a double tap does nothing more');
  t.mock.timers.tick(501);
  navBar.navigate('notebook');
  assert.deepEqual(heard, ['scroll-top', 'focus-search']);
  assert.equal(scrolls.length, 1);
  stop();
});

test('a tab never scrolled, or whose list left the page, counts as at its top; a restored position counts too', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: true }) };
  const heard: TabReselect[] = [];
  const stop = onTabReselect('sentences', action => heard.push(action));
  const { navBar } = renderNavBar('sentences');
  navBar.navigate('sentences');
  assert.deepEqual(heard, ['focus-search']);

  const gone = fakeScroller(900);
  navBar.handleScroll(gone.event);
  gone.scroller.isConnected = false;
  t.mock.timers.tick(600);
  navBar.navigate('sentences');
  assert.deepEqual(heard, ['focus-search', 'focus-search']);
  assert.equal(gone.scrolls.length, 0);

  const restored = fakeScroller(900);
  navBar.syncScrollPosition(restored.scroller as unknown as HTMLElement);
  t.mock.timers.tick(600);
  navBar.navigate('sentences');
  assert.deepEqual(restored.scrolls, [{ top: 0, behavior: 'auto' }], 'reduced motion scrolls at once');
  assert.deepEqual(heard, ['focus-search', 'focus-search', 'scroll-top']);
  stop();
});

test('a tab listening like the Notebook catches its list up on each reselect, and focuses its search box inside the tap', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 3_000_000 });
  (globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false }) };
  // views/Notebook.tsx's registration, with a stand-in for its clock bump and its search box.
  let clockBumps = 0;
  const focused: string[] = [];
  const searchInputRef = { current: { focus: () => focused.push(`focus at bump ${clockBumps}`) } };
  const stop = onTabReselect('notebook', action => {
    clockBumps += 1;
    if (action === 'focus-search') searchInputRef.current?.focus();
  });
  const { navBar } = renderNavBar('notebook');

  const { event } = fakeScroller(1_200);
  navBar.handleScroll(event);
  t.mock.timers.tick(600);
  navBar.navigate('notebook');
  assert.equal(clockBumps, 1, 'scrolled up: the list catches up');
  assert.deepEqual(focused, []);

  t.mock.timers.tick(600);
  navBar.navigate('notebook');
  assert.deepEqual(focused, ['focus at bump 2'], 'at the top: the caret goes in the box before navigate returns');
  stop();
  t.mock.timers.tick(600);
  navBar.navigate('notebook');
  assert.equal(clockBumps, 2, 'a tab that stopped listening hears nothing');
});
