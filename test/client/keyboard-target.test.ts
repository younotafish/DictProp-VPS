import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptKeyRepeat } from '../../components/keyboardTarget.ts';

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
