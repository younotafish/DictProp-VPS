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

const fab = (props: Partial<FabProps> = {}) => renderToStaticMarkup(createElement(SearchFab, {
  unseenCount: 0, readyCount: 0, runningCount: 0, isBusy: false, onClick: () => {}, ...props,
}));
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
  { isBusy: true, runningCount: 2 },
  { readyCount: 3, unseenCount: 2 },
  { readyCount: 3 },
  { readyCount: 1, unseenCount: 1, isBusy: true, runningCount: 1 },
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

/** The count on the button's corner, as its tone and number, or null when there is none. */
const badgeOf = (markup: string) => {
  const badges = [...markup.matchAll(
    /<span class="absolute -top-1 -right-1 min-w-\[18px\] h-\[18px\] (bg-[a-z]+-\d+) text-white text-\[10px\] font-bold rounded-full flex items-center justify-center border-2 border-white">(\d+)<\/span>/g,
  )];
  assert.ok(badges.length <= 1, 'one count at most');
  return badges[0] ? { tone: badges[0][1], count: Number(badges[0][2]) } : null;
};
const labelOf = (markup: string) => /^<button aria-label="([^"]*)"/.exec(markup)?.[1];
const spins = (markup: string) => markup.includes('lucide-loader-circle animate-spin');
/** The classes every state of the button has, besides its offset: where it is, its size and its shape. */
const BASE = ['fixed', 'right-4', 'z-[55]', 'w-12', 'h-12', 'rounded-full', 'flex', 'items-center', 'justify-center', 'shadow-lg', 'transition-all', 'duration-300'];
const QUIET = ['bg-white/70', 'text-slate-500', 'border', 'border-slate-200/50', 'opacity-60', 'hover:opacity-100'];
const LIT = ['bg-indigo-500', 'text-white', 'shadow-indigo-300'];
const BUSY = ['bg-white/90', 'text-indigo-500', 'border', 'border-slate-200'];
/** The classes that give the button its look in this state. */
const lookOf = (markup: string) => {
  const classes = otherClassesOf(markup);
  assert.deepEqual(classes.slice(0, BASE.length), BASE);
  return classes.slice(BASE.length);
};

test('with nothing to show, the button is the quiet search icon', () => {
  const markup = fab();
  assert.equal(labelOf(markup), 'Search');
  assert.deepEqual(lookOf(markup), QUIET);
  assert.equal(badgeOf(markup), null);
  assert.ok(markup.includes('lucide-search') && !spins(markup));
});

test('new results light the button up with a red count of the new ones only', () => {
  const markup = fab({ unseenCount: 2, readyCount: 5 });
  assert.equal(labelOf(markup), 'Search (2 new results)');
  assert.deepEqual(lookOf(markup), LIT);
  assert.deepEqual(badgeOf(markup), { tone: 'bg-red-500', count: 2 });
  assert.equal(labelOf(fab({ unseenCount: 1, readyCount: 1 })), 'Search (1 new result)');
});

test('once every result has been seen the button goes quiet, with a small slate count of them', () => {
  const markup = fab({ readyCount: 3 });
  assert.equal(labelOf(markup), 'Search (3 results)');
  assert.deepEqual(lookOf(markup), QUIET);
  assert.deepEqual(badgeOf(markup), { tone: 'bg-slate-400', count: 3 });
  assert.equal(labelOf(fab({ readyCount: 1 })), 'Search (1 result)');
});

test('while lookups run the spinner counts the new results if there are any, otherwise the lookups running', () => {
  const unseen = fab({ isBusy: true, runningCount: 4, unseenCount: 2, readyCount: 3 });
  assert.ok(spins(unseen));
  assert.deepEqual(lookOf(unseen), BUSY);
  assert.equal(labelOf(unseen), 'Search (2 new results)');
  assert.deepEqual(badgeOf(unseen), { tone: 'bg-red-500', count: 2 });

  const seen = fab({ isBusy: true, runningCount: 4, readyCount: 3 });
  assert.equal(labelOf(seen), 'Search (in progress)');
  assert.deepEqual(badgeOf(seen), { tone: 'bg-indigo-500', count: 4 }, 'the seen results are not counted');

  const scanning = fab({ isBusy: true });
  assert.ok(spins(scanning));
  assert.equal(labelOf(scanning), 'Search (in progress)');
  assert.equal(badgeOf(scanning), null, 'a sentence scan alone has no count');
});

test('the button never animates beyond its spinner', () => {
  for (const state of FAB_STATES) {
    const markup = fab(state);
    assert.doesNotMatch(markup, /animate-(ping|pulse)/, JSON.stringify(state));
    assert.equal(markup.includes('animate-spin'), !!state.isBusy, JSON.stringify(state));
  }
});
