import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptKeyRepeat, isDialogOpenOutside } from '../../components/keyboardTarget.ts';

// components/keyboardTarget.ts, the checks every window-level shortcut table shares.

test('a held letter, Space, Enter or any other key acts once; a held arrow keeps stepping', () => {
  for (const key of ['a', 'S', ' ', 'Enter', 'Escape', 'Backspace', 'Delete', '1', 'Tab']) {
    assert.equal(acceptKeyRepeat({ key, repeat: true }), false, `held ${JSON.stringify(key)} is ignored`);
  }
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(acceptKeyRepeat({ key, repeat: true }), true, `held ${key} steps again`);
  }
});

test('every first press acts', () => {
  for (const key of ['a', 'S', ' ', 'Enter', 'Escape', 'Backspace', '1', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(acceptKeyRepeat({ key, repeat: false }), true, `a first press of ${JSON.stringify(key)} acts`);
  }
});

// isDialogOpenOutside reads the dialogs from the document: a fake one lists them, each showing or hidden.
const dialog = (showing: boolean) => ({ getClientRects: () => ({ length: showing ? 1 : 0 }) });
const showDialogs = (...dialogs: ReturnType<typeof dialog>[]) => {
  (globalThis as { document?: unknown }).document = { querySelectorAll: () => dialogs };
};
const containerOf = (...inside: object[]) => ({ contains: (node: object) => inside.includes(node) }) as unknown as Element;

test('a dialog showing outside the view takes its keys; one inside it, or a hidden one, does not', () => {
  const sheet = dialog(true);
  showDialogs(sheet);
  assert.equal(isDialogOpenOutside(containerOf()), true, 'the search sheet over the card view');
  assert.equal(isDialogOpenOutside(containerOf(sheet)), false, 'the view\'s own playback panel');
  assert.equal(isDialogOpenOutside(null), true, 'with no view, any showing dialog counts');

  showDialogs(dialog(false));
  assert.equal(isDialogOpenOutside(containerOf()), false, 'a dialog with no boxes is hidden');
  showDialogs();
  assert.equal(isDialogOpenOutside(null), false, 'no dialog');
});
