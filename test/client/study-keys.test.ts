import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDashboardKey, resolveStudyKey, type DashboardKeyState, type StudyKeyEvent, type StudyKeyState } from '../../services/studyKeys.ts';

const press = (key: string, modifiers: Partial<StudyKeyEvent> = {}): StudyKeyEvent => ({
  key, repeat: false, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, ...modifiers,
});
/** The repeats a key sends while it's held down. */
const held = (key: string) => press(key, { repeat: true });

/** A card with its answer hidden and nothing to undo, the key going to the page. */
const card = (overrides: Partial<StudyKeyState> = {}): StudyKeyState => ({
  phase: 'card', revealed: false, canUndo: false, undoing: false, canResume: false, typing: false, onControl: false, dialogOutside: false,
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
  }
});

test('on the summary Enter is Done, unless the keyboard focused a control; Space does nothing there', () => {
  const summary = card({ phase: 'summary', canUndo: true });
  assert.deepEqual(resolveStudyKey(press('Enter'), summary), { type: 'done' });
  assert.deepEqual(resolveStudyKey(press('Enter'), { ...summary, undoing: true }), { type: 'done' }, 'an undo under way doesn\'t hold Done');
  assert.equal(resolveStudyKey(press('Enter'), { ...summary, onControl: true }), null, 'a missed word or button the keyboard focused');
  assert.equal(resolveStudyKey(held('Enter'), summary), null, 'a held Enter was Done once');
  assert.equal(resolveStudyKey(press(' '), summary), null);
  assert.equal(resolveStudyKey(press('Enter', { metaKey: true }), summary), null);
});

test('U undoes the last grade while one can be undone and no undo is under way, on a card or the summary', () => {
  assert.deepEqual(resolveStudyKey(press('u'), card({ canUndo: true })), { type: 'undo' });
  assert.deepEqual(resolveStudyKey(press('U'), card({ canUndo: true, revealed: true })), { type: 'undo' });
  assert.deepEqual(resolveStudyKey(press('u'), card({ phase: 'summary', canUndo: true })), { type: 'undo' });
  assert.equal(resolveStudyKey(press('u'), card()), null, 'nothing to undo');
  assert.equal(resolveStudyKey(press('u'), card({ canUndo: true, undoing: true })), null, 'already undoing');
});

test('while an undo is under way, 1-4 and Space or Enter do nothing, and stay the session\'s', () => {
  for (const key of ['1', '2', '3', '4']) {
    assert.deepEqual(resolveStudyKey(press(key), card({ revealed: true, canUndo: true, undoing: true })), { type: 'swallow' }, key);
  }
  for (const key of [' ', 'Enter']) {
    assert.deepEqual(resolveStudyKey(press(key), card({ canUndo: true, undoing: true })), { type: 'swallow' }, key);
    // A control the keyboard focused still gets the key.
    assert.equal(resolveStudyKey(press(key), card({ canUndo: true, undoing: true, onControl: true })), null, `${key} on a control`);
  }
});

test('a held key acts once: its repeats grade, reveal and undo nothing, and a held 1-4 stays the session\'s', () => {
  const revealed = card({ revealed: true, canUndo: true });
  for (const key of ['1', '2', '3', '4']) {
    assert.deepEqual(resolveStudyKey(held(key), revealed), { type: 'swallow' }, `held ${key} answered`);
    assert.deepEqual(resolveStudyKey(held(key), card()), { type: 'swallow' }, `held ${key} unanswered`);
  }
  for (const key of [' ', 'Enter']) assert.equal(resolveStudyKey(held(key), card()), null, `held ${key}`);
  assert.equal(resolveStudyKey(held('u'), card({ canUndo: true })), null, 'held U');
  // The table has no arrow keys, held or not.
  assert.equal(resolveStudyKey(held('ArrowRight'), revealed), null);
  assert.equal(resolveStudyKey(press('ArrowRight'), revealed), null);
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

test('on the summary of a session ended early, R resumes it; elsewhere R is not a study key', () => {
  const ended = card({ phase: 'summary', canResume: true, canUndo: true });
  assert.deepEqual(resolveStudyKey(press('r'), ended), { type: 'resume' });
  assert.deepEqual(resolveStudyKey(press('R'), ended), { type: 'resume' });
  assert.equal(resolveStudyKey(held('r'), ended), null, 'a held R resumed once');
  assert.equal(resolveStudyKey(press('r', { metaKey: true }), ended), null, 'Cmd+R reloads');
  assert.equal(resolveStudyKey(press('r'), { ...ended, typing: true }), null);
  assert.equal(resolveStudyKey(press('r'), card({ phase: 'summary' })), null, 'a finished session has nothing to resume');
  assert.equal(resolveStudyKey(press('r'), card({ canResume: true })), null, 'not on a card');
});

test('on the dashboard Enter presses Start once per press, while there is something to review', () => {
  const dashboard = (overrides: Partial<DashboardKeyState> = {}): DashboardKeyState =>
    ({ canStart: true, typing: false, onControl: false, dialogOutside: false, ...overrides });
  assert.deepEqual(resolveDashboardKey(press('Enter'), dashboard()), { type: 'start' });
  assert.equal(resolveDashboardKey(press('Enter'), dashboard({ canStart: false })), null, 'All caught up');
  assert.equal(resolveDashboardKey(held('Enter'), dashboard()), null, 'a held Enter, as from the summary\'s Done, starts nothing');
  assert.equal(resolveDashboardKey(press('Enter'), dashboard({ onControl: true })), null, 'a control the keyboard focused');
  assert.equal(resolveDashboardKey(press('Enter'), dashboard({ typing: true })), null);
  assert.equal(resolveDashboardKey(press('Enter'), dashboard({ dialogOutside: true })), null, 'the search sheet over the tab');
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'defaultPrevented'] as const) {
    assert.equal(resolveDashboardKey(press('Enter', { [modifier]: true }), dashboard()), null, modifier);
  }
  // The number keys stay the tab bar's, and Space does nothing here.
  for (const key of ['1', '2', '3', '4', ' ', 'u', 'r']) assert.equal(resolveDashboardKey(press(key), dashboard()), null, key);
});
