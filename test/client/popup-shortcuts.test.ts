import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePopupShortcut, type PopupKey, type PopupKeyState } from '../../components/review/popupShortcuts.ts';

const key = (name: string, modifiers: Partial<Omit<PopupKey, 'key'>> = {}): PopupKey =>
  ({ key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, repeat: false, ...modifiers });
/** The repeats a key sends while it's held down. */
const held = (name: string, modifiers: Partial<Omit<PopupKey, 'key' | 'repeat'>> = {}) => key(name, { ...modifiers, repeat: true });
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

test('Alt, and Cmd or Ctrl with any key but an example digit, leave the key to the browser: Cmd+R reloads, Cmd+P prints', () => {
  assert.equal(action(key('r', { metaKey: true })), null);
  assert.equal(action(key('r', { ctrlKey: true })), null);
  assert.equal(action(key('R', { metaKey: true, shiftKey: true })), null);
  assert.equal(action(key('r', { metaKey: true }), { saved: false }), null);
  assert.equal(action(key('p', { metaKey: true })), null);
  assert.equal(action(key(' ', { ctrlKey: true })), null);
  assert.equal(action(key('Enter', { metaKey: true })), null);
  assert.equal(action(key('ArrowLeft', { metaKey: true }), { pageCount: 2 }), null);
  for (const name of ['r', 'p', 'e', 'd', ' ', 'Enter', 'ArrowRight', '1']) {
    assert.equal(action(key(name, { altKey: true }), { pageCount: 2 }), null, `Alt+${name}`);
  }
  assert.equal(action(key('1', { metaKey: true, altKey: true })), null);
  // Shift alone changes nothing but R.
  assert.deepEqual(action(key('ArrowRight', { shiftKey: true }), { pageCount: 2 }), { type: 'next' });
});

test('a held key acts once: its repeats do nothing and stay the popup\'s, and a held arrow keeps paging', () => {
  for (const pressed of [held('r'), held('R', { shiftKey: true }), held('d'), held('p'), held('e'), held(' '), held('Enter'), held('1', { metaKey: true })]) {
    assert.deepEqual(action(pressed, { pageCount: 2 }), { type: 'swallow' }, `held ${pressed.key}`);
  }
  assert.deepEqual(action(held('r'), { saved: false }), { type: 'swallow' }, 'a held R saves once');
  assert.deepEqual(action(held('Enter'), { saved: false }), { type: 'swallow' }, 'a held Enter saves once');
  assert.deepEqual(action(held('ArrowRight'), { pageCount: 2 }), { type: 'next' });
  assert.deepEqual(action(held('ArrowLeft'), { pageCount: 2 }), { type: 'prev' });
  // A held Enter can't press a focused control again either; a held Space on one is the control's.
  assert.deepEqual(action(held('Enter'), { onControl: true }), { type: 'swallow' });
  assert.equal(action(held(' '), { onControl: true }), null);
  // Keys the popup leaves alone stay alone when held.
  for (const pressed of [held('x'), held('ArrowUp'), held('ArrowRight'), held('r', { metaKey: true }), held('Enter', { metaKey: true })]) {
    assert.equal(action(pressed), null, `held ${pressed.key}`);
  }
  assert.equal(action(held('d'), { saved: false }), null);
});

test('keys typed into a text field are never shortcuts, and other keys do nothing', () => {
  for (const pressed of [key('r'), key(' '), key('ArrowLeft'), key('1', { metaKey: true }), key('Enter')]) {
    assert.equal(action(pressed, { typing: true, pageCount: 2, saved: false }), null, pressed.key);
  }
  for (const name of ['Tab', 'Escape', 'x', 'ArrowUp', '1']) assert.equal(action(key(name)), null, name);
});
