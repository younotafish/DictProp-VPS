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
  sentenceSaved: false,
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

test('the box says it takes a word, a phrase or a sentence', () => {
  const markup = bar();
  assert.match(markup, /placeholder="Look up a word, phrase or sentence…"/);
  assert.match(markup, /role="combobox" aria-label="Look up a word, phrase or sentence"/);
});

/** The button saving the typed sentence, or showing it saved: its attributes, or null when the box has neither. */
const sentenceButtonOf = (markup: string) => /<button([^>]*(?:aria-label="Save this sentence"|aria-label="Sentence saved")[^>]*)>/.exec(markup)?.[1] ?? null;

test('a typed sentence can be saved, and once saved the bookmark is a disabled "Sentence saved" check', () => {
  const unsaved = sentenceButtonOf(bar({ query: 'It ran the gamut of emotions.', canSaveSentence: true }));
  assert.match(unsaved ?? '', /title="Save this sentence to your Sentences list" aria-label="Save this sentence"/);
  assert.doesNotMatch(unsaved ?? '', /disabled/);
  const saved = sentenceButtonOf(bar({ query: 'It ran the gamut of emotions.', canSaveSentence: true, sentenceSaved: true }));
  assert.match(saved ?? '', /^ disabled="" title="Saved to your Sentences list" aria-label="Sentence saved" class="[^"]*bg-violet-600 text-white/);
  const markup = bar({ query: 'It ran the gamut of emotions.', canSaveSentence: true, sentenceSaved: true });
  assert.match(markup, /aria-label="Analyze"/, 'Send still analyzes the saved sentence');
  assert.equal(sentenceButtonOf(bar({ query: 'gamut' })), null, 'a word has neither');
});
