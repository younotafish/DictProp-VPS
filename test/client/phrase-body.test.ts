import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { SearchResult, VocabCard } from '../../types.ts';
import { PhraseBody } from '../../views/detail/PhraseBody.tsx';
import { PhraseVocabCard } from '../../views/detail/PhraseVocabCard.tsx';

// A phrase card's body (views/detail/PhraseBody.tsx): what its Key Vocabulary cards are handed. PhraseBody uses no
// hooks, so it's called as a function and its elements are read without rendering the components in them.

/** The elements of `type` in `node`, found through each element's children. */
function elementsOf(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(child => elementsOf(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const found = node.type === type ? [node as ReactElement<Record<string, unknown>>] : [];
  return [...found, ...elementsOf(node.props.children, type)];
}

const vocab = (id: string, word: string) => ({ id, word, examples: [] }) as Partial<VocabCard> as VocabCard;

test('a Key Vocabulary card\'s Refresh is the card view\'s forced AI lookup, as the header\'s Refresh is, not a plain search', () => {
  const onRefresh = (_text: string) => {};
  const onSearch = (_text: string) => {};
  const phrase = {
    id: 'phrase-1', query: 'come clean about it', translation: '坦白', grammar: '', visualKeyword: 'confession', pronunciation: '',
    vocabs: [vocab('v1', 'come clean'), vocab('v2', 'about')],
  } as Partial<SearchResult> as SearchResult;
  const body = PhraseBody({ phrase, onSaveVocab: () => {}, isVocabSaved: () => false, onSearch, onRefresh });
  const cards = elementsOf(body, PhraseVocabCard);
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.equal(card.props.onRefresh, onRefresh);
    assert.equal(card.props.onSearch, onSearch, 'a tap on a term still searches');
  }
});
