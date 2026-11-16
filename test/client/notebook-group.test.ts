import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeVocabStoredItem } from '../../services/items.ts';
import type { StoredItem } from '../../types.ts';
import { NotebookGroup } from '../../views/notebook/NotebookGroup.tsx';

// views/notebook/NotebookGroup.tsx: a word's row in the Notebook, one card per meaning.

const sense = (word: string, meaning: string): StoredItem => makeVocabStoredItem({
  id: `${word}:${meaning}`, word, sense: meaning, chinese: '', ipa: '', definition: meaning, synonyms: [], antonyms: [],
  confusables: [], examples: [], history: '', register: '', mnemonic: '',
});

const render = (items: StoredItem[]) => renderToStaticMarkup(createElement(NotebookGroup, {
  group: { title: items[0].data.id, items }, section: 'main', now: 0, onViewDetail: () => {}, onDelete: () => {},
}));
const arrows = (html: string) => [...html.matchAll(/aria-label="(Previous meaning|Next meaning)"/g)].map(match => match[1]);

test('a word with several meanings has both arrows from its first meaning on, since they loop like a swipe', () => {
  for (const count of [2, 3]) {
    const html = render(['money', 'river', 'tilt'].slice(0, count).map(meaning => sense('bank', meaning)));
    assert.deepEqual(arrows(html), ['Previous meaning', 'Next meaning'], `${count} meanings`);
  }
});

test('a word with one meaning has no arrows', () => {
  assert.deepEqual(arrows(render([sense('ubiquitous', 'everywhere')])), []);
});
