import assert from 'node:assert/strict';
import test from 'node:test';
import { isMacKeyboard, isUndoShortcut, unarchiveUndo, type UndoShortcutContext } from '../../services/undoRules.ts';
import { isMacPlatform } from '../../services/platform.ts';
import type { StoredItem } from '../../types.ts';

// services/undoRules.ts: what the undo pill takes back, and when its shortcut acts.

const card = (fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab',
  data: { id: 'w1', word: 'gamut', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id: 'w1', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
  ...fields,
});

test('undoing an unarchive archives the card again as it was, unless it was archived again meanwhile', () => {
  const before = card({ isArchived: true, updatedAt: 10 });
  const undo = unarchiveUndo(before);
  assert.deepEqual(undo(card({ isArchived: undefined, updatedAt: 20 })), card({ isArchived: true, updatedAt: 10 }));
  const archivedAgain = card({ isArchived: true, updatedAt: 30 });
  assert.equal(undo(archivedAgain), archivedAgain);
});

const key = (fields: Partial<Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> = {}) => ({
  key: 'z', repeat: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...fields,
});
const onMac: UndoShortcutContext = { typing: false, undoOpen: true, isMac: true, modalOpen: false };
const elsewhere: UndoShortcutContext = { ...onMac, isMac: false };

test('⌘Z undoes on a Mac and Ctrl+Z elsewhere, each with its own modifier only', () => {
  assert.equal(isUndoShortcut(key({ metaKey: true }), onMac), true);
  assert.equal(isUndoShortcut(key({ ctrlKey: true }), onMac), false);
  assert.equal(isUndoShortcut(key({ ctrlKey: true }), elsewhere), true);
  assert.equal(isUndoShortcut(key({ metaKey: true }), elsewhere), false);
  assert.equal(isUndoShortcut(key({ metaKey: true, ctrlKey: true }), onMac), false);
  assert.equal(isUndoShortcut(key({ key: 'Z', metaKey: true }), onMac), true, 'Caps Lock on');
  assert.equal(isUndoShortcut(key(), onMac), false, 'a plain z');
  assert.equal(isUndoShortcut(key({ key: 'y', metaKey: true }), onMac), false);
});

test('the undo shortcut leaves redo, Alt, a held key, typing, a closed pill and an open dialog alone', () => {
  assert.equal(isUndoShortcut(key({ key: 'Z', metaKey: true, shiftKey: true }), onMac), false, 'redo');
  assert.equal(isUndoShortcut(key({ ctrlKey: true, altKey: true }), elsewhere), false);
  assert.equal(isUndoShortcut(key({ metaKey: true, repeat: true }), onMac), false, 'held down');
  assert.equal(isUndoShortcut(key({ metaKey: true }), { ...onMac, typing: true }), false, 'the text field\'s own undo wins');
  assert.equal(isUndoShortcut(key({ metaKey: true }), { ...onMac, undoOpen: false }), false, 'nothing to undo');
  assert.equal(isUndoShortcut(key({ metaKey: true }), { ...onMac, modalOpen: true }), false, 'a decision dialog has the keys');
});

test('the shell tells a ⌘ keyboard as the shortcut sheet\'s labels do', () => {
  const navigators = [
    { platform: 'MacIntel' },
    { platform: 'Win32' },
    { platform: 'Linux x86_64' },
    { platform: 'iPhone' },
    { platform: '', userAgentData: { platform: 'macOS' } },
    { platform: '', userAgentData: { platform: 'Windows' } },
  ];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const nav of navigators) {
      Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
      assert.equal(isMacKeyboard(nav), isMacPlatform(), JSON.stringify(nav));
      assert.equal(isMacKeyboard(), isMacPlatform(), `${JSON.stringify(nav)}, read from the navigator`);
    }
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    assert.equal(isMacKeyboard(), false, 'no navigator');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
  assert.equal(isMacKeyboard({ platform: 'MacIntel' }), true);
  assert.equal(isMacKeyboard({ platform: 'Win32' }), false);
});
