import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inputEnterAction, searchSheetKeys, type SheetKeyEvent, type SheetKeyState,
} from '../../components/search/searchSheetKeys.ts';

const SHEET: SheetKeyState = {
  typing: false, dialogAbove: false, onControl: false, resultCount: 3, resultIndex: 1, meaningCount: 4, meaningIndex: 0, hasCard: true,
};
const press = (key: string, modifiers: Partial<SheetKeyEvent> = {}, state: Partial<SheetKeyState> = {}) =>
  searchSheetKeys({ key, repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }, { ...SHEET, ...state });

test('S saves the meaning on screen, Shift+S every meaning, P says the word, E reads the examples, Space plays or pauses', () => {
  assert.deepEqual(press('s'), { type: 'save' });
  assert.deepEqual(press('S', { shiftKey: true }), { type: 'saveAll' });
  assert.deepEqual(press('S'), { type: 'save' }, 'with Caps Lock on, S still only saves');
  assert.deepEqual(press('p'), { type: 'pronounce' });
  assert.deepEqual(press('e'), { type: 'readExamples' });
  assert.deepEqual(press(' '), { type: 'togglePlayback' });
  for (const key of ['P', 'E', ' ']) assert.equal(press(key, { shiftKey: true }), null, `Shift+${key}`);
  assert.equal(press('x'), null);
});

test('Space presses a control the keyboard focused, instead of playing', () => {
  assert.equal(press(' ', {}, { onControl: true }), null);
  assert.deepEqual(press('s', {}, { onControl: true }), { type: 'save' }, 'the letters still act');
});

test('←/→ step through the meanings, round from either end', () => {
  assert.deepEqual(press('ArrowRight'), { type: 'meaning', index: 1 });
  assert.deepEqual(press('ArrowLeft'), { type: 'meaning', index: 3 }, 'back from the first comes round to the last');
  assert.deepEqual(press('ArrowRight', {}, { meaningIndex: 3 }), { type: 'meaning', index: 0 });
  assert.deepEqual(press('ArrowRight', {}, { meaningCount: 1 }), { type: 'swallow' }, 'one meaning: nowhere to go, nothing behind moves');
});

test('↑/↓ move between results without wrapping, and are always the sheet\'s while it is open', () => {
  assert.deepEqual(press('ArrowUp'), { type: 'result', index: 0 });
  assert.deepEqual(press('ArrowDown'), { type: 'result', index: 2 });
  assert.deepEqual(press('ArrowUp', {}, { resultIndex: 0 }), { type: 'swallow' });
  assert.deepEqual(press('ArrowDown', {}, { resultIndex: 2 }), { type: 'swallow' });
  assert.deepEqual(press('ArrowDown', {}, { resultCount: 1, resultIndex: 0 }), { type: 'swallow' }, 'one result: its card scrolls instead');
});

test('Cmd or Ctrl with 1–4 reads that example; other combinations are left to the browser', () => {
  assert.deepEqual(press('1', { metaKey: true }), { type: 'readExample', index: 0 });
  assert.deepEqual(press('4', { ctrlKey: true }), { type: 'readExample', index: 3 });
  assert.equal(press('5', { metaKey: true }), null);
  assert.equal(press('s', { metaKey: true }), null, 'Cmd+S is not S');
  assert.equal(press('c', { ctrlKey: true }), null);
});

test('a held S, P, E or Space does nothing; a held arrow keeps stepping', () => {
  for (const key of ['s', 'p', 'e', ' ']) assert.equal(press(key, { repeat: true }), null, key);
  assert.equal(press('1', { metaKey: true, repeat: true }), null);
  assert.deepEqual(press('ArrowRight', { repeat: true }), { type: 'meaning', index: 1 });
  assert.deepEqual(press('ArrowDown', { repeat: true }), { type: 'result', index: 2 });
});

test('nothing while typing, under a dialog, or with Alt', () => {
  for (const key of ['s', 'ArrowRight', 'ArrowDown', ' ']) {
    assert.equal(press(key, {}, { typing: true }), null, `typing ${key}`);
    assert.equal(press(key, {}, { dialogAbove: true }), null, `dialog ${key}`);
    assert.equal(press(key, { altKey: true }), null, `Alt+${key}`);
  }
});

test('a comparison has no card: only the arrows act on it', () => {
  const comparison = { hasCard: false, meaningCount: 0 };
  assert.deepEqual(press('ArrowDown', {}, comparison), { type: 'result', index: 2 });
  assert.deepEqual(press('ArrowRight', {}, comparison), { type: 'swallow' });
  for (const key of ['s', 'p', 'e', ' ']) assert.equal(press(key, {}, comparison), null, key);
  assert.equal(press('1', { metaKey: true }, comparison), null);
});

test('Enter in the search box opens the highlighted sentence, else looks up the text, else opens the results', () => {
  const box = { query: '', highlightedIndex: -1, suggestionCount: 0, readyCount: 0 };
  assert.equal(inputEnterAction({ ...box, query: 'gamut', highlightedIndex: 1, suggestionCount: 3 }), 'open-suggestion');
  assert.equal(inputEnterAction({ ...box, query: 'gamut', highlightedIndex: 3, suggestionCount: 3 }), 'submit', 'a highlight past the list');
  assert.equal(inputEnterAction({ ...box, query: 'gamut', readyCount: 2 }), 'submit');
  assert.equal(inputEnterAction({ ...box, query: '   ', readyCount: 2 }), 'view-results');
  assert.equal(inputEnterAction({ ...box, readyCount: 1 }), 'view-results');
  assert.equal(inputEnterAction(box), null);
});
