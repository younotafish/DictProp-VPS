import assert from 'node:assert/strict';
import test from 'node:test';
import { handleNavKey, shouldHandleNavKey, type NavKeyContext, type NavKeyEvent } from '../../hooks/useKeyboardNavigation.ts';
import { isDialogOpenOutside } from '../../components/keyboardTarget.ts';

// hooks/useKeyboardNavigation.ts: the card view's arrows, Enter, Space and Cmd/Ctrl+S go to the layer on top.

const FREE: NavKeyContext = { typing: false, ime: false, guard: false };
const VIEW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '];

test('the view takes its keys unless they go into text or an input method, or a layer above it has them', () => {
  for (const key of VIEW_KEYS) {
    assert.equal(shouldHandleNavKey({ key, repeat: false }, FREE), true, key);
    assert.equal(shouldHandleNavKey({ key, repeat: false }, { ...FREE, guard: true }), false, `${key} under a sheet or dialog`);
    assert.equal(shouldHandleNavKey({ key, repeat: false }, { ...FREE, typing: true }), false, `${key} while typing`);
    assert.equal(shouldHandleNavKey({ key, repeat: false }, { ...FREE, ime: true }), false, `${key} while composing`);
  }
  for (const key of ['Enter', ' ']) assert.equal(shouldHandleNavKey({ key, repeat: true }, FREE), false, `held ${JSON.stringify(key)}`);
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(shouldHandleNavKey({ key, repeat: true }, FREE), true, `held ${key} keeps stepping`);
  }
});

/** A key press that records what the view did with it, and the handlers of a card that record what ran. */
function press(key: string, { mod = false, repeat = false } = {}) {
  const event = {
    key, repeat, metaKey: mod, ctrlKey: false, prevented: false, stopped: false,
    preventDefault() { event.prevented = true; },
    stopImmediatePropagation() { event.stopped = true; },
  };
  return event satisfies NavKeyEvent;
}
function viewWith(ran: string[]) {
  return {
    onArrowUp: () => ran.push('up'), onArrowDown: () => ran.push('down'), onArrowLeft: () => ran.push('left'),
    onArrowRight: () => ran.push('right'), onEnter: () => ran.push('enter'), onSave: () => ran.push('save'),
  };
}

test('with a sheet or dialog above the view, its keys and their browser defaults go to that layer', () => {
  const ran: string[] = [];
  for (const key of VIEW_KEYS) {
    const event = press(key);
    handleNavKey(event, { ...FREE, guard: true }, viewWith(ran));
    assert.deepEqual([event.prevented, event.stopped], [false, false], `${key} scrolls or presses in the layer above`);
  }
  // Cmd+S never opens the browser's Save Page dialog, but saves nothing behind the layer; Cmd+F and Escape keep their
  // defaults off as before (GlobalSearch and the escape stack take them).
  const keptOff = [press('s', { mod: true }), press('f', { mod: true }), press('Escape')];
  for (const event of keptOff) handleNavKey(event, { ...FREE, guard: true }, viewWith(ran));
  assert.deepEqual(keptOff.map(event => event.prevented), [true, true, true]);
  assert.deepEqual(ran, []);
});

test('with the view on top, the arrows step, Enter reads, Space never scrolls and Cmd+S saves', () => {
  const ran: string[] = [];
  const events = Object.fromEntries([...VIEW_KEYS, 'Escape'].map(key => [key, press(key)]));
  const save = press('s', { mod: true });
  for (const event of [...Object.values(events), save]) handleNavKey(event, FREE, viewWith(ran));
  assert.deepEqual(ran, ['up', 'down', 'left', 'right', 'enter', 'save']);
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.deepEqual([events[key].prevented, events[key].stopped], [true, true], key);
  }
  assert.deepEqual([events.Enter.prevented, events[' '].prevented, events.Escape.prevented, save.prevented], [true, true, true, true]);

  const heldSpace = press(' ', { repeat: true });
  handleNavKey(heldSpace, FREE, viewWith(ran));
  assert.equal(heldSpace.prevented, true, 'a held Space doesn\'t scroll the card either');
});

test('while typing or composing, the keys stay the field\'s; Escape and the Cmd keys keep their defaults off', () => {
  const ran: string[] = [];
  for (const context of [{ ...FREE, typing: true }, { ...FREE, ime: true }]) {
    for (const key of VIEW_KEYS) {
      const event = press(key);
      handleNavKey(event, context, viewWith(ran));
      assert.equal(event.prevented, false, key);
    }
    const escape = press('Escape');
    const save = press('s', { mod: true });
    handleNavKey(escape, context, viewWith(ran));
    handleNavKey(save, context, viewWith(ran));
    assert.deepEqual([escape.prevented, save.prevented], [true, true]);
  }
  assert.deepEqual(ran, []);
});

test('a dialog counts as above the view only when it shows and sits outside the view', () => {
  const view = { contains: (node: unknown) => node === insideView };
  const shown = () => [{}];
  const insideView = { getClientRects: shown };
  const outside = { getClientRects: shown };
  const hiddenOutside = { getClientRects: () => [] };
  const dialogs: unknown[] = [];
  (globalThis as { document?: unknown }).document = { querySelectorAll: () => dialogs };
  const container = view as unknown as Element;

  assert.equal(isDialogOpenOutside(container), false, 'no dialog');
  dialogs.push(insideView);
  assert.equal(isDialogOpenOutside(container), false, 'the view\'s own panel');
  dialogs.push(hiddenOutside);
  assert.equal(isDialogOpenOutside(container), false, 'a dialog with no boxes is not showing');
  dialogs.push(outside);
  assert.equal(isDialogOpenOutside(container), true, 'the search sheet, a confirm or the shortcut list');
});
