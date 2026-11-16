import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useLibraryActions } from '../../hooks/useLibraryActions.ts';
import { isMacKeyboard, isUndoShortcut, planReset, shouldReset, unarchiveUndo, type UndoShortcutContext } from '../../services/undoRules.ts';
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

const reviewed = (totalReviews: number) => ({ ...card().srs, totalReviews });

test('only a card that has been reviewed has a schedule to reset', () => {
  assert.equal(shouldReset(undefined), false);
  assert.equal(shouldReset(reviewed(0)), false);
  assert.equal(shouldReset(reviewed(1)), true);
});

test('a reset starts a reviewed card over, leaves a deleted one deleted, and changes nothing on a new one', () => {
  assert.equal(planReset(undefined), 'missing');
  assert.equal(planReset(card({ srs: reviewed(3) })), 'reset');
  assert.equal(planReset(card({ srs: reviewed(3), isDeleted: true })), 'deleted');
  assert.equal(planReset(card({ srs: reviewed(0) })), 'nothing-to-reset');
  assert.equal(planReset(card({ srs: reviewed(0), isDeleted: true })), 'deleted');
});

// hooks/useLibraryActions.ts, run once through a server render; its handlers keep working afterwards on the fakes they
// were given, which record the order of what they're asked to do.
function renderActions(initial: StoredItem[]) {
  let items = initial;
  const calls: string[] = [];
  const library = {
    userId: 'u1',
    latestItemsRef: { get current() { return items; }, set current(next: StoredItem[]) { items = next; } },
    updateItems: (transform: (current: StoredItem[]) => StoredItem[]) => (items = transform(items)),
    replaceItem: (id: string, update: (item: StoredItem) => StoredItem) => {
      const index = items.findIndex(item => item.data.id === id);
      if (index < 0) return undefined;
      const next = update(items[index]);
      items = items.map((item, at) => (at === index ? next : item));
      calls.push(`replace ${id}`);
      return next;
    },
    persistChangedItems: async (changed: StoredItem[], label: string) => { calls.push(`persist ${label} ${changed.map(item => item.data.id).join(',')}`); },
  };
  const detail = {
    removeFromDetailView: (remove: () => void) => { remove(); return undefined; },
    removeItemFromDetailContext: () => {},
    removeSentenceFromDetailContext: () => {},
  };
  const undo = { offerUndo: (verb: string, before: StoredItem) => { calls.push(`offer ${verb} ${before.data.id}`); } };
  let actions: ReturnType<typeof useLibraryActions> | undefined;
  const Probe = () => { actions = useLibraryActions(library, detail, undo); return null; };
  renderToStaticMarkup(createElement(Probe));
  return { actions: actions!, calls, items: () => items };
}

test('a reset offers its undo before storing and pushing, so the push finds the card held', () => {
  const { actions, calls, items } = renderActions([card({ srs: reviewed(4), updatedAt: 5 })]);
  assert.equal(actions.resetSRS('w1'), true);
  assert.deepEqual(calls, ['replace w1', 'offer Reset w1', 'persist Reset w1']);
  assert.equal(items()[0].srs.totalReviews, 0);
  assert.equal(items()[0].isDeleted, undefined);
});

test('resetting a deleted or a never-reviewed card does nothing, and a missing one is left to the caller', () => {
  const deleted = renderActions([card({ srs: reviewed(4), isDeleted: true })]);
  assert.equal(deleted.actions.resetSRS('w1'), true);
  assert.deepEqual(deleted.calls, [], 'no save, no offer: the card stays deleted');
  assert.equal(deleted.items()[0].isDeleted, true);

  const fresh = renderActions([card({ srs: reviewed(0) })]);
  assert.equal(fresh.actions.resetSRS('w1'), true);
  assert.deepEqual(fresh.calls, [], 'no new offer, so an open one stays');

  assert.equal(renderActions([]).actions.resetSRS('w1'), false);
});

test('unarchiving offers its undo before storing and pushing; a card that was not archived offers none', async () => {
  const archived = renderActions([card({ isArchived: true })]);
  await archived.actions.handleUnarchive('w1');
  assert.deepEqual(archived.calls, ['replace w1', 'offer Unarchived w1', 'persist Unarchive w1']);
  assert.equal(archived.items()[0].isArchived, undefined);

  const active = renderActions([card()]);
  await active.actions.handleUnarchive('w1');
  assert.deepEqual(active.calls, ['replace w1', 'persist Unarchive w1']);
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
