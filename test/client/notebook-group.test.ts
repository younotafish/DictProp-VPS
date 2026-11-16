import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { makeVocabStoredItem } from '../../services/items.ts';
import type { StoredItem } from '../../types.ts';
import { nextMeaning, NotebookGroup } from '../../views/notebook/NotebookGroup.tsx';
import { readRepoFile } from '../support/paths.ts';

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

test('a step loops past either end, and one taken after the last meaning was deleted counts from the new last', () => {
  assert.equal(nextMeaning(0, -1, 3), 2, 'back from the first meaning is the last');
  assert.equal(nextMeaning(2, 1, 3), 0, 'on from the last meaning is the first');
  assert.equal(nextMeaning(0, 1, 3), 1);
  assert.equal(nextMeaning(2, -1, 3), 1);
  assert.equal(nextMeaning(1, 1, 2), 0);
  assert.equal(nextMeaning(0, -1, 2), 1);
  // The fourth of four meanings showed and was deleted, leaving the index at 3 among three: the third shows.
  assert.equal(nextMeaning(3, 1, 3), 0);
  assert.equal(nextMeaning(3, -1, 3), 1);
  assert.equal(nextMeaning(5, -1, 2), 0);
});

test('the arrows, swipes and trackpad all step by nextMeaning; only the dots set a meaning directly', () => {
  // The repo has no DOM to click the arrows in, so the row's source shows every way it sets the meaning shown.
  const file = 'views/notebook/NotebookGroup.tsx';
  const source = ts.createSourceFile(file, readRepoFile(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const steps: string[] = [];
  const others: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === 'setCurrentIndex' && !ts.isBindingElement(node.parent)) {
      if (ts.isCallExpression(node.parent) && node.parent.expression === node) steps.push(node.parent.arguments.map(argument => argument.getText()).join(', '));
      else others.push(node.parent.parent.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(steps.length > 0);
  for (const step of steps) assert.match(step, /\bnextMeaning\(/, step);
  assert.deepEqual(others, ['onSelect={setCurrentIndex}'], 'a dot sets the meaning it stands for, always in range');
});
