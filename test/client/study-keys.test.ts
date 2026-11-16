import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStudyKey, type StudyKeyEvent, type StudyKeyState } from '../../services/studyKeys.ts';

const press = (key: string, modifiers: Partial<StudyKeyEvent> = {}): StudyKeyEvent => ({
  key, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, ...modifiers,
});

/** A card with its answer hidden and nothing to undo, the key going to the page. */
const card = (overrides: Partial<StudyKeyState> = {}): StudyKeyState => ({
  phase: 'card', revealed: false, canUndo: false, undoing: false, typing: false, onControl: false, dialogOutside: false,
  ...overrides,
});

test('keys 1-4 grade the revealed card in button order, and do nothing but stay the session\'s before the reveal', () => {
  const revealed = card({ revealed: true });
  assert.deepEqual(['1', '2', '3', '4'].map(key => resolveStudyKey(press(key), revealed)), [
    { type: 'grade', rating: 'again' },
    { type: 'grade', rating: 'hard' },
    { type: 'grade', rating: 'good' },
    { type: 'grade', rating: 'easy' },
  ]);
  for (const key of ['1', '2', '3', '4']) {
    assert.deepEqual(resolveStudyKey(press(key), card()), { type: 'swallow' }, `${key} before the reveal`);
    assert.deepEqual(resolveStudyKey(press(key), card({ phase: 'summary' })), { type: 'swallow' }, `${key} on the summary`);
  }
  assert.equal(resolveStudyKey(press('5'), revealed), null);
});

test('Space and Enter show the answer, unless the keyboard focused a control they should press', () => {
  for (const key of [' ', 'Enter']) {
    assert.deepEqual(resolveStudyKey(press(key), card()), { type: 'reveal' }, key);
    assert.equal(resolveStudyKey(press(key), card({ onControl: true })), null, `${key} on a focused control`);
    assert.equal(resolveStudyKey(press(key), card({ revealed: true })), null, `${key} once the answer shows`);
    assert.equal(resolveStudyKey(press(key), card({ phase: 'summary' })), null, `${key} on the summary`);
  }
});

test('U undoes the last grade while one can be undone and no undo is under way, on a card or the summary', () => {
  assert.deepEqual(resolveStudyKey(press('u'), card({ canUndo: true })), { type: 'undo' });
  assert.deepEqual(resolveStudyKey(press('U'), card({ canUndo: true, revealed: true })), { type: 'undo' });
  assert.deepEqual(resolveStudyKey(press('u'), card({ phase: 'summary', canUndo: true })), { type: 'undo' });
  assert.equal(resolveStudyKey(press('u'), card()), null, 'nothing to undo');
  assert.equal(resolveStudyKey(press('u'), card({ canUndo: true, undoing: true })), null, 'already undoing');
});

test('keys with a modifier, keys a view already used, typing and an open dialog are left alone', () => {
  const ready = card({ revealed: true, canUndo: true });
  for (const key of ['1', 'u', ' ', 'Enter']) {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'defaultPrevented'] as const) {
      assert.equal(resolveStudyKey(press(key, { [modifier]: true }), ready), null, `${modifier} ${key}`);
      assert.equal(resolveStudyKey(press(key, { [modifier]: true }), card()), null, `${modifier} ${key} unrevealed`);
    }
    assert.equal(resolveStudyKey(press(key), { ...ready, typing: true }), null, `${key} typed`);
    assert.equal(resolveStudyKey(press(key), card({ typing: true })), null, `${key} typed unrevealed`);
    assert.equal(resolveStudyKey(press(key), { ...ready, dialogOutside: true }), null, `${key} under a dialog`);
    assert.equal(resolveStudyKey(press(key), card({ dialogOutside: true })), null, `${key} under a dialog unrevealed`);
  }
  assert.equal(resolveStudyKey(press('Escape'), ready), null, 'Escape goes through the escape stack');
});
