import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePopupShortcut, type PopupKey, type PopupKeyState } from '../../components/review/popupShortcuts.ts';

const key = (name: string, modifiers: Partial<Omit<PopupKey, 'key'>> = {}): PopupKey =>
  ({ key: name, shiftKey: false, metaKey: false, ctrlKey: false, ...modifiers });
const state = (overrides: Partial<PopupKeyState> = {}): PopupKeyState =>
  ({ typing: false, onControl: false, pageCount: 1, saved: true, ...overrides });
const action = (pressed: PopupKey, overrides: Partial<PopupKeyState> = {}) => resolvePopupShortcut(pressed, state(overrides));

test('arrows page between meanings only when there is more than one', () => {
  assert.deepEqual(action(key('ArrowLeft'), { pageCount: 3 }), { type: 'prev' });
  assert.deepEqual(action(key('ArrowRight'), { pageCount: 2 }), { type: 'next' });
  assert.equal(action(key('ArrowRight'), { pageCount: 1 }), null);
});

test('Space plays or pauses, unless a focused control should take it', () => {
  assert.deepEqual(action(key(' ')), { type: 'togglePlayback' });
  assert.equal(action(key(' '), { onControl: true }), null);
});

test('P says the word, and Cmd or Ctrl with a digit from 1 to 4 reads that example', () => {
  assert.deepEqual(action(key('p')), { type: 'pronounce' });
  assert.deepEqual(action(key('P', { shiftKey: true })), { type: 'pronounce' });
  assert.deepEqual(action(key('1', { metaKey: true })), { type: 'readExample', index: 0 });
  assert.deepEqual(action(key('4', { ctrlKey: true })), { type: 'readExample', index: 3 });
  assert.equal(action(key('5', { metaKey: true })), null);
  assert.equal(action(key('2')), null, 'a bare digit is not a popup shortcut');
});

test('E reads both examples in turn, but leaves Cmd+E and Ctrl+E alone', () => {
  assert.deepEqual(action(key('e')), { type: 'readBoth' });
  assert.deepEqual(action(key('E', { shiftKey: true })), { type: 'readBoth' });
  assert.equal(action(key('e', { metaKey: true })), null);
  assert.equal(action(key('e', { ctrlKey: true })), null);
});

test('on a saved meaning R is Got it, Shift+R resets and D deletes; Cmd+D and Ctrl+D are left alone', () => {
  assert.deepEqual(action(key('r')), { type: 'gotIt' });
  assert.deepEqual(action(key('R', { shiftKey: true })), { type: 'reset' });
  assert.deepEqual(action(key('d')), { type: 'delete' });
  assert.deepEqual(action(key('D', { shiftKey: true })), { type: 'delete' });
  assert.equal(action(key('d', { metaKey: true })), null);
  assert.equal(action(key('d', { ctrlKey: true })), null);
});

test("Enter does nothing on a saved meaning, so it can't press a clicked Got it or armed delete again", () => {
  assert.deepEqual(action(key('Enter')), { type: 'swallow' }, 'the popup keeps Enter from the button the mouse clicked');
  assert.equal(action(key('Enter'), { onControl: true }), null, 'a control the keyboard moved to still takes Enter');
});

test('on an unsaved meaning R and Enter save it, D does nothing, and Enter on a focused control presses it', () => {
  assert.deepEqual(action(key('r'), { saved: false }), { type: 'save' });
  assert.deepEqual(action(key('R', { shiftKey: true }), { saved: false }), { type: 'save' });
  assert.deepEqual(action(key('Enter'), { saved: false }), { type: 'save' });
  assert.equal(action(key('Enter'), { saved: false, onControl: true }), null);
  assert.equal(action(key('d'), { saved: false }), null);
});

test('today the keys other than E, D and the example digits ignore Cmd and Ctrl', () => {
  assert.deepEqual(action(key('r', { metaKey: true })), { type: 'gotIt' });
  assert.deepEqual(action(key('R', { metaKey: true, shiftKey: true })), { type: 'reset' });
  assert.deepEqual(action(key('p', { metaKey: true })), { type: 'pronounce' });
  assert.deepEqual(action(key(' ', { ctrlKey: true })), { type: 'togglePlayback' });
  assert.deepEqual(action(key('ArrowLeft', { metaKey: true }), { pageCount: 2 }), { type: 'prev' });
});

test('keys typed into a text field are never shortcuts, and other keys do nothing', () => {
  for (const pressed of [key('r'), key(' '), key('ArrowLeft'), key('1', { metaKey: true }), key('Enter')]) {
    assert.equal(action(pressed, { typing: true, pageCount: 2, saved: false }), null, pressed.key);
  }
  for (const name of ['Tab', 'Escape', 'x', 'ArrowUp', '1']) assert.equal(action(key(name)), null, name);
});
