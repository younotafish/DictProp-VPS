import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { useWordActions } from '../../views/detail/useWordActions.ts';

// What the word card's actions do to the library (views/detail/useWordActions.ts): Got it, from the header, R, or a
// double tap or click, on archived cards and just after an Unarchive.

/** Runs a hook once, in a server render, and hands back what it returned; refs and callbacks keep working after. */
function capture<T>(useHook: () => T): T {
  let result: T | undefined;
  const Probe = () => { result = useHook(); return null; };
  renderToStaticMarkup(createElement(Probe));
  return result as T;
}

const apple = (archived: boolean): StoredItem => ({
  type: 'vocab',
  data: { id: 'apple-1', word: 'apple', examples: [] } as Partial<VocabCard> as VocabCard,
  savedAt: 0,
  srs: SRSAlgorithm.createNew('apple-1', 'vocab', 0),
  ...(archived ? { isArchived: true } : {}),
});

/** The word card's actions on "apple", whose saved copy is `library`'s; `done` records what reached the library. */
function appleActions(library: { current: StoredItem[] }, done: string[]) {
  const saved = library.current[0];
  return capture(() => useWordActions({
    data: saved.data, type: 'vocab', title: 'apple', savedItemMatch: saved, isSaved: true, savedItemsRef: library,
    isVocabSaved: () => true, onSave: item => { done.push(`save ${item.data.id}`); },
    onDelete: id => { done.push(`delete ${id}`); }, onArchive: id => { done.push(`archive ${id}`); },
    onUnarchive: id => { done.push(`unarchive ${id}`); }, onResetSRS: id => { done.push(`reset ${id}`); return true; },
    onUpdateSRS: id => { done.push(`review ${id}`); }, setShowActionMenu: () => {},
    tryRemember: () => true, showRemembered: (_next, _now, id) => { done.push(`Remembered! ${id}`); },
  }));
}

test('on an archived card Got it reviews nothing: its header offers Unarchive, and R and the double tap match it', () => {
  const done: string[] = [];
  appleActions({ current: [apple(true)] }, done).handleRemember();
  assert.deepEqual(done, []);

  appleActions({ current: [apple(false)] }, done).handleRemember();
  assert.deepEqual(done, ['Remembered! apple-1', 'review apple-1']);
});

test('right after Unarchive, which puts Got it in its place beside the trash, Got it and the trash wait out 0.7 s', t => {
  let clock = 10_000;
  t.mock.method(performance, 'now', () => clock);
  const done: string[] = [];
  const library = { current: [apple(true)] };
  const actions = appleActions(library, done);
  actions.handleUnarchiveItem();
  // The card stays on screen, unarchived, and its header shows Got it where Unarchive was.
  library.current = [apple(false)];
  clock += 300;
  actions.handleRemember(); // the second click of a double click on Unarchive, or the second tap of a double tap
  actions.handleDeleteItem(); // or that press landing on the trash beside it
  actions.handleArchiveItem(); // or A pressed twice: unarchive, then archive again
  actions.handleResetSRS();
  assert.deepEqual(done, ['unarchive apple-1']);

  clock += 400;
  actions.handleRemember();
  assert.deepEqual(done, ['unarchive apple-1', 'Remembered! apple-1', 'review apple-1']);
});
