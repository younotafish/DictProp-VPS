import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchInputBar } from '../../components/search/SearchInputBar.tsx';

type BarProps = Parameters<typeof SearchInputBar>[0];

const bar = (props: Partial<BarProps> = {}) => renderToStaticMarkup(createElement(SearchInputBar, {
  inputRef: createRef<HTMLInputElement>(),
  query: '',
  setQuery: () => {},
  suggestions: [],
  highlightedIndex: -1,
  setHighlightedIndex: () => {},
  suggestionsListRef: createRef<HTMLDivElement>(),
  suggestionsId: 'suggestions',
  onOpenSuggestion: () => {},
  onSubmit: () => {},
  canSaveSentence: false,
  onSaveSentence: () => {},
  readyCount: 0,
  unseenCount: 0,
  onViewResults: () => {},
  onClose: () => {},
  ...props,
}));

/** The results pill: its label, its classes and the text after its icon, or null when the box has none. */
const pillOf = (markup: string) => {
  const match = /<button aria-label="(Show [^"]*)" class="([^"]*)"><svg[^>]*>.*?<\/svg>(.*?)<\/button>/.exec(markup);
  return match ? { label: match[1], classes: match[2], text: match[3] } : null;
};

const PILL = 'shrink-0 h-7 px-2.5 rounded-full bg-indigo-500 text-white text-xs font-bold flex items-center gap-1 hover:bg-indigo-600 transition-colors';

test('the results pill says how many results are new', () => {
  assert.deepEqual(pillOf(bar({ readyCount: 3, unseenCount: 2 })), { label: 'Show 3 results (2 new)', classes: PILL, text: '2 new' });
  assert.deepEqual(pillOf(bar({ readyCount: 1, unseenCount: 1 })), { label: 'Show 1 result (1 new)', classes: PILL, text: '1 new' });
});

test('once every result has been seen the pill shows their number', () => {
  assert.deepEqual(pillOf(bar({ readyCount: 3 })), { label: 'Show 3 results', classes: PILL, text: '3' });
  assert.deepEqual(pillOf(bar({ readyCount: 1 })), { label: 'Show 1 result', classes: PILL, text: '1' });
});

test('the box has no results pill before a result is ready, and nothing in it pulses', () => {
  assert.equal(pillOf(bar()), null);
  for (const props of [{}, { readyCount: 2, unseenCount: 2 }, { readyCount: 2 }]) {
    assert.doesNotMatch(bar({ query: 'gamut', ...props }), /animate-/);
  }
});
