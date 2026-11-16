import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SRSData, StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { TAP_CONTROL_SELECTOR, acceptRemember, doubleTapControlSelector } from '../../services/reviewGestures.ts';
import { useRememberToast } from '../../views/detail/useRememberToast.ts';
import { useSentenceActions } from '../../views/detail/useSentenceActions.ts';
import { useWordActions } from '../../views/detail/useWordActions.ts';

// services/reviewGestures.ts, the rules that keep review gestures from misfiring, and the card view's hooks that
// follow them.

/** Runs a hook once, in a server render, and hands back what it returned; refs and callbacks keep working after. */
function capture<T>(useHook: () => T): T {
  let result: T | undefined;
  const Probe = () => { result = useHook(); return null; };
  renderToStaticMarkup(createElement(Probe));
  return result as T;
}

test('a remember counts unless the same item counted less than 1.5 s before', () => {
  const last = { id: 'apple', at: 10_000 };
  assert.equal(acceptRemember(null, 'apple', 10_000), true, 'the first remember counts');
  assert.equal(acceptRemember(last, 'apple', 10_000), false, 'the dblclick a double-tap makes lands at once');
  assert.equal(acceptRemember(last, 'apple', 11_499), false);
  assert.equal(acceptRemember(last, 'apple', 11_500), true, 'from 1.5 s on, the same item counts again');
  assert.equal(acceptRemember(last, 'pear', 10_001), true, 'another item always counts');
  assert.equal(acceptRemember(last, 'apple', 10_400, 300), true, 'the window can be given');
});

const vocabItem = (id: string, word: string): StoredItem => ({
  type: 'vocab',
  data: {
    id, word, sense: '', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '',
  },
  savedAt: 0,
  srs: SRSAlgorithm.createNew(id, 'vocab', 0),
});

const sentenceItem = (id: string): StoredItem => ({
  type: 'sentence',
  data: { id, text: `Sentence ${id}.`, sourceWord: id },
  savedAt: 0,
  srs: SRSAlgorithm.createNew(id, 'sentence', 0),
});

test('in sentence review R, ↓, R reviews both sentences at once, and one gesture reviews a sentence once', () => {
  const { tryRemember } = capture(() => useRememberToast());
  const reviewed: string[] = [];
  const confirmed: string[] = [];
  const onScreen = { current: sentenceItem('A') as StoredItem | null };
  const { handleRemember } = capture(() => useSentenceActions({
    currentSentence: onScreen.current, currentSentenceRef: onScreen, isSentencePreview: false,
    catalogSentencePreview: false, onSave: () => {}, onDelete: () => {},
    onUpdateSRS: id => { reviewed.push(id); }, tryRemember,
    showRemembered: (_next: SRSData, _now: number, id: string) => { confirmed.push(id); },
  }));

  handleRemember();
  handleRemember(); // the dblclick the browser makes of a touch double-tap
  onScreen.current = sentenceItem('B');
  handleRemember();
  assert.deepEqual(reviewed, ['A', 'B']);
  assert.deepEqual(confirmed, ['A', 'B'], 'each confirmation names the sentence it confirms');
});

test('on a word card Got it on the next card counts at once, and the confirmation names the card on screen', () => {
  const { tryRemember } = capture(() => useRememberToast());
  const reviewed: string[] = [];
  const confirmed: string[] = [];
  const library = [vocabItem('apple-1', 'apple'), vocabItem('pear-1', 'pear')];
  const actionsFor = (card: StoredItem) => capture(() => useWordActions({
    data: card.data, type: card.type, title: (card.data as VocabCard).word, savedItemMatch: card, isSaved: true,
    savedItemsRef: { current: library }, isVocabSaved: () => true, onSave: () => {}, onDelete: () => {},
    onUpdateSRS: id => { reviewed.push(id); }, setShowActionMenu: () => {}, tryRemember,
    showRemembered: (_next: SRSData, _now: number, id: string) => { confirmed.push(id); },
  }));

  const apple = actionsFor(library[0]);
  apple.handleRemember();
  apple.handleRemember();
  actionsFor(library[1]).handleRemember();
  assert.deepEqual(reviewed, ['apple-1', 'pear-1']);
  assert.deepEqual(confirmed, ['apple-1', 'pear-1']);
});

/** The simple selectors a selector list names, in no particular order. */
const parts = (selector: string) => new Set(selector.split(',').map(part => part.trim()));

test('a double tap never counts on a native control; on a word card the ARIA-button look-up words are controls too', () => {
  for (const mode of ['card', 'sentence'] as const) {
    for (const control of ['button', 'a', 'input', 'textarea', 'select', 'label', '[contenteditable="true"]']) {
      assert.ok(parts(doubleTapControlSelector(mode)).has(control), `${control} is a control in ${mode} mode`);
    }
  }
  assert.ok(parts(doubleTapControlSelector('card')).has('[role="button"]'));
  assert.ok(!parts(doubleTapControlSelector('sentence')).has('[role="button"]'), 'a double tap on a sentence word still remembers');
  assert.equal(doubleTapControlSelector('sentence'), TAP_CONTROL_SELECTOR);
});

test('a word card\'s taps leave alone the controls they always did', () => {
  const before = 'button, a, [role="button"], input, textarea, select, label, [contenteditable="true"]';
  assert.deepEqual(parts(doubleTapControlSelector('card')), parts(before));
});
