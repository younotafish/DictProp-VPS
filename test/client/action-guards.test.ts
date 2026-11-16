import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { acceptDestructive, acceptListReview, acceptRepeat } from '../../services/actionGuards.ts';
import { useSentenceActions } from '../../views/detail/useSentenceActions.ts';
import { useWordActions } from '../../views/detail/useWordActions.ts';

// services/actionGuards.ts, one action per press, and the card view's destructive actions that use it.

/** Runs a hook once, in a server render, and hands back what it returned; refs and callbacks keep working after. */
function capture<T>(useHook: () => T): T {
  let result: T | undefined;
  const Probe = () => { result = useHook(); return null; };
  renderToStaticMarkup(createElement(Probe));
  return result as T;
}

test('a press acts once its window has passed since the last press that acted, and the first press always does', () => {
  const lastAt = { current: -Infinity };
  assert.equal(acceptRepeat(lastAt, 1_000, 300), true);
  assert.equal(lastAt.current, 1_000);
  assert.equal(acceptRepeat(lastAt, 1_299, 300), false);
  assert.equal(lastAt.current, 1_000, 'a press that doesn\'t act leaves the clock alone');
  assert.equal(acceptRepeat(lastAt, 1_300, 300), true);
  assert.equal(lastAt.current, 1_300);
});

test('a second delete, archive or reset within 0.7 s is ignored, and a list Reviewed within 0.5 s', () => {
  const destructive = { current: -Infinity };
  assert.equal(acceptDestructive(destructive, 10_000), true);
  assert.equal(acceptDestructive(destructive, 10_699), false);
  assert.equal(acceptDestructive(destructive, 10_700), true);

  const reviewed = { current: -Infinity };
  assert.equal(acceptListReview(reviewed, 10_000), true);
  assert.equal(acceptListReview(reviewed, 10_499), false);
  assert.equal(acceptListReview(reviewed, 10_500), true);
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

test('on a word card a doubled Delete deletes one card, and an archive or reset pressed right after does nothing', () => {
  const done: string[] = [];
  const apple = vocabItem('apple-1', 'apple');
  const actions = capture(() => useWordActions({
    data: apple.data, type: 'vocab', title: 'apple', savedItemMatch: apple, isSaved: true,
    savedItemsRef: { current: [apple] }, isVocabSaved: () => true, onSave: item => { done.push(`save ${item.data.id}`); },
    onDelete: id => { done.push(`delete ${id}`); }, onArchive: id => { done.push(`archive ${id}`); },
    onResetSRS: id => { done.push(`reset ${id}`); return true; }, setShowActionMenu: () => {},
    tryRemember: () => true, showRemembered: () => {},
  }));

  actions.handleDeleteItem();
  actions.handleDeleteItem(); // the second tap of a double tap on the trash
  actions.handleArchiveItem();
  actions.handleResetSRS();
  assert.deepEqual(done, ['delete apple-1']);
});

test('in sentence review a doubled Delete or Shift+R acts once, the two sharing one guard', () => {
  const done: string[] = [];
  const sentence: StoredItem = {
    type: 'sentence',
    data: { id: 'sentence-1', text: 'She finally came clean.', sourceWord: 'come clean' },
    savedAt: 0,
    srs: SRSAlgorithm.createNew('sentence-1', 'sentence', 0),
  };
  const actionsFor = () => capture(() => useSentenceActions({
    currentSentence: sentence, currentSentenceRef: { current: sentence }, isSentencePreview: false,
    catalogSentencePreview: false, onSave: () => {}, onDelete: id => { done.push(`delete ${id}`); },
    onResetSRS: id => { done.push(`reset ${id}`); return true; }, tryRemember: () => true, showRemembered: () => {},
  }));

  const first = actionsFor();
  first.handleResetSRS();
  first.handleResetSRS();
  first.handleDeleteItem();
  const second = actionsFor();
  second.handleDeleteItem();
  second.handleDeleteItem();
  assert.deepEqual(done, ['reset sentence-1', 'delete sentence-1']);
});
