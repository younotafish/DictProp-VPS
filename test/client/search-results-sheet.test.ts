import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchResultsSheet } from '../../components/search/SearchResultsSheet.tsx';
import type { QueueItem } from '../../components/search/searchQueue.ts';
import type { SearchResult } from '../../types.ts';

type SheetProps = Parameters<typeof SearchResultsSheet>[0];

const result = (query: string, cards: number): SearchResult => ({
  id: `r-${query}`, query, translation: '', grammar: '', visualKeyword: query, pronunciation: '', timestamp: 1,
  vocabs: Array.from({ length: cards }, (_, i) => ({
    id: `${query}-${i}`, word: query, sense: '', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [],
    confusables: [], examples: [], history: '', register: '', mnemonic: '',
  })),
});

const lookup = (id: string, cards = 1, seen = false): QueueItem => ({ id, kind: 'lookup', query: id, status: 'ready', results: result(id, cards), seen });

const sheet = (props: Partial<SheetProps> & Pick<SheetProps, 'viewingItem'>) => renderToStaticMarkup(createElement(SearchResultsSheet, {
  dialogRef: createRef<HTMLDivElement>(),
  meaningIndex: 0,
  meaningCount: props.viewingItem.results?.vocabs.length ?? 0,
  readyItems: [props.viewingItem],
  resultIndex: 0,
  onShowResult: () => {},
  isVocabSaved: () => false,
  onClose: () => {},
  onSaveWord: () => {},
  onDismiss: () => {},
  onSaveAll: () => {},
  onClearAll: () => {},
  ...props,
}));

test('a lookup that came back without a card opens the sheet, says so, and offers nothing to save', () => {
  const markup = sheet({ viewingItem: lookup('gamut', 0) });
  assert.match(markup, /role="dialog" aria-modal="true" aria-label="Search result: gamut"/);
  assert.match(markup, />No vocabulary card was returned\.</);
  assert.doesNotMatch(markup, />(Save|All saved)</, 'an empty list of cards is not "all saved"');
  assert.match(markup, /aria-label="Dismiss this result"/);
});

test('a lookup with a card shows the card it is given instead, with its Save button', () => {
  const markup = sheet({ viewingItem: lookup('gamut'), children: createElement('p', null, 'the card') });
  assert.match(markup, /<p>the card<\/p>/);
  assert.doesNotMatch(markup, /No vocabulary card/);
  assert.match(markup, /<\/svg>Save<\/button>/);
});

const DOT = '<span aria-hidden="true" class="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-red-500 align-middle"></span><span class="sr-only"> (new)</span>';
/** The strip's result chips, each as its text with the dot marked. */
const chipsOf = (markup: string) => [...markup.matchAll(/<button class="shrink-0 px-3 py-1\.5 rounded-full text-xs font-medium transition-all [^"]*">(.*?)<\/button>/g)]
  .map(match => match[1].replace(DOT, ' •'));

test('in the strip, a result the sheet has not shown yet carries a dot', () => {
  const readyItems = [lookup('gamut', 1, true), lookup('impasse'), lookup('rot', 1, true), lookup('tangent')];
  assert.deepEqual(chipsOf(sheet({ viewingItem: readyItems[0], readyItems, resultIndex: 0 })), ['gamut', 'impasse •', 'rot', 'tangent •']);
});

test('the open result never carries the dot, since it is being seen', () => {
  const readyItems = [lookup('gamut', 1, true), lookup('impasse'), lookup('tangent')];
  assert.deepEqual(chipsOf(sheet({ viewingItem: readyItems[1], readyItems, resultIndex: 1 })), ['gamut', 'impasse', 'tangent •']);
});
