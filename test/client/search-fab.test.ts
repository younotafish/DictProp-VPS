import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GlobalSearch } from '../../components/GlobalSearch.tsx';
import { SearchFab } from '../../components/search/SearchFab.tsx';
import { SearchToasts } from '../../components/search/SearchToasts.tsx';

type FabProps = Parameters<typeof SearchFab>[0];
type ToastProps = Parameters<typeof SearchToasts>[0];

/** The classes on the first element of `markup`. */
const classesOf = (markup: string): string[] => (/class="([^"]*)"/.exec(markup)?.[1] ?? '').split(/\s+/).filter(Boolean);
const bottomOf = (markup: string): string[] => classesOf(markup).filter(name => name.startsWith('bottom-'));
/** The first element's classes apart from its bottom offset, which is all aboveTabBar may change. */
const otherClassesOf = (markup: string): string[] => classesOf(markup).filter(name => !name.startsWith('bottom-'));

const fab = (props: Partial<FabProps> = {}) =>
  renderToStaticMarkup(createElement(SearchFab, { readyCount: 0, busyCount: 0, isBusy: false, onClick: () => {}, ...props }));
const errorToast = (props: Partial<ToastProps> = {}) => renderToStaticMarkup(createElement(SearchToasts, {
  saveToast: null, statusToast: null, error: { msg: 'Could not analyze "gamut".', query: 'gamut' },
  onRetry: () => {}, onDismissError: () => {}, ...props,
}));

// Where the button and the error toast float: on a tab, above the tab bar (and Study's grade footer); over a card,
// on the card float line that clears the lesson row; and where App doesn't say yet, the old offsets.
const FAB_BOTTOM = {
  unset: 'bottom-24',
  tab: 'bottom-[calc(var(--nav-h)+var(--tab-footer-h,0px)+0.5rem)]',
  card: 'bottom-[var(--card-float-bottom,6rem)]',
};
const TOAST_BOTTOM = {
  unset: 'bottom-44',
  tab: 'bottom-[calc(var(--nav-h)+var(--tab-footer-h,0px)+4rem)]',
  card: 'bottom-[calc(var(--card-float-bottom,6rem)+7.5rem)]',
};
const PLACES = [['unset', undefined], ['tab', true], ['card', false]] as const;

const FAB_STATES: Partial<FabProps>[] = [
  {},
  { isBusy: true },
  { isBusy: true, busyCount: 2 },
  { readyCount: 3 },
  { readyCount: 1, isBusy: true, busyCount: 1 },
];

test('the search button sits above the tab bar on a tab, on the card float line over a card, and at bottom-24 when not told', () => {
  for (const state of FAB_STATES) {
    for (const [place, aboveTabBar] of PLACES) {
      assert.deepEqual(bottomOf(fab({ ...state, aboveTabBar })), [FAB_BOTTOM[place]], `${place} ${JSON.stringify(state)}`);
    }
  }
});

test('where the search button floats changes only its bottom offset', () => {
  for (const state of FAB_STATES) {
    const unset = fab(state);
    for (const aboveTabBar of [true, false]) {
      const placed = fab({ ...state, aboveTabBar });
      assert.deepEqual(otherClassesOf(placed), otherClassesOf(unset));
      assert.equal(placed.replace(/class="[^"]*"/, ''), unset.replace(/class="[^"]*"/, ''), 'the rest of the markup is the same');
    }
  }
});

test('the error toast sits above the search button: over the tab bar on a tab, over the attach-image button on a card', () => {
  for (const [place, aboveTabBar] of PLACES) {
    const markup = errorToast({ aboveTabBar });
    assert.match(markup, /^<div role="alert" class="/);
    assert.deepEqual(bottomOf(markup), [TOAST_BOTTOM[place]], place);
    assert.deepEqual(otherClassesOf(markup), otherClassesOf(errorToast()), place);
  }
});

test('the save and status toasts stay at the top whatever aboveTabBar says', () => {
  for (const aboveTabBar of [undefined, true, false]) {
    const markup = renderToStaticMarkup(createElement(SearchToasts, {
      saveToast: 'Sentence saved', statusToast: 'Found 2 expressions — analyzing…', error: null,
      onRetry: () => {}, onDismissError: () => {}, aboveTabBar,
    }));
    assert.equal((markup.match(/fixed top-4 left-1\/2/g) ?? []).length, 2);
    assert.doesNotMatch(markup, /bottom-/);
  }
});

test('GlobalSearch hands aboveTabBar to its search button', () => {
  for (const [place, aboveTabBar] of PLACES) {
    const markup = renderToStaticMarkup(createElement(GlobalSearch, {
      onSave: () => {}, isVocabSaved: () => false, findSavedByWord: () => [], onSearch: () => {}, isOnline: true, aboveTabBar,
    }));
    assert.match(markup, /^<button aria-label="Search"/, 'idle, the search shows only its button');
    assert.deepEqual(bottomOf(markup), [FAB_BOTTOM[place]], place);
  }
});
