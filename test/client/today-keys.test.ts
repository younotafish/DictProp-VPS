import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTodayKey, type TodayKeyAction, type TodayKeyEvent, type TodayKeyState } from '../../views/today/todayKeys.ts';

// Today's keys (views/today/todayKeys.ts) on each screen and footer, as TodayView asks the table with the DOM facts it
// reads. A key the table returns null for is left to the rest of the app (the tab keys, the browser's chords).

const BASE: TodayKeyState = {
  screen: 'card', canUndo: false, undoing: false, appUndoOpen: false, isMac: true, typing: false, onControl: false, dialogOutside: false,
};

const press = (key: string, event: Partial<TodayKeyEvent> = {}): TodayKeyEvent => ({
  key, repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...event,
});

const resolve = (key: string, state: Partial<TodayKeyState>, event: Partial<TodayKeyEvent> = {}): TodayKeyAction | null =>
  resolveTodayKey(press(key, event), { ...BASE, ...state });

const SWALLOW: TodayKeyAction = { type: 'swallow' };
const PLAN: Partial<TodayKeyState> = { screen: 'plan', hasPrimary: true };
const CUE: Partial<TodayKeyState> = { screen: 'card', footer: 'cue', canHint: true };
const MEET: Partial<TodayKeyState> = { screen: 'card', footer: 'meet', sayOpen: true, hasExample: true };
const RUN: Partial<TodayKeyState> = { screen: 'card', footer: 'run', hasExample: true };
const SUMMARY: Partial<TodayKeyState> = { screen: 'summary', hasPrimary: true, canResume: true, canUndo: true };

test('on the plan Enter presses the primary button, once per press, and every other key is left to the app', () => {
  assert.deepEqual(resolve('Enter', PLAN), { type: 'primary' });
  assert.equal(resolve('Enter', PLAN, { repeat: true }), null, 'held');
  assert.equal(resolve('Enter', { ...PLAN, hasPrimary: false }), null, 'Done for today, or no set yet');
  assert.equal(resolve('Enter', { ...PLAN, onControl: true }), null, 'a focused button presses itself');
  for (const key of ['1', '2', '3', ' ', 'u', 'h', 'ArrowLeft']) assert.equal(resolve(key, PLAN), null, `${key} stays the app's`);
  assert.equal(resolve('z', { ...PLAN, canUndo: true }, { metaKey: true }), null, '⌘Z is the app\'s on the plan');
});

test('on a cue Space and Enter reveal and H takes the hint while it can still be taken', () => {
  assert.deepEqual(resolve(' ', CUE), { type: 'reveal' });
  assert.deepEqual(resolve('Enter', CUE), { type: 'reveal' });
  assert.deepEqual(resolve('h', CUE), { type: 'hint' });
  assert.deepEqual(resolve('H', CUE), { type: 'hint' }, 'with Caps Lock on');
  assert.equal(resolve('h', { ...CUE, canHint: false }), null, 'already shown');
  assert.equal(resolve('p', CUE), null, 'no answer to say yet');
  assert.equal(resolve('e', { ...CUE, hasExample: true }), null);
  assert.equal(resolve(' ', CUE, { repeat: true }), null, 'a held Space reveals once');
  assert.equal(resolve(' ', { ...CUE, onControl: true }), null, 'a focused button presses itself');
  assert.equal(resolve('ArrowLeft', CUE), null, 'the Meet\'s arrows wait for its answer');
});

test('the session owns 1-3 on every card and summary, so an early, late or held press never switches tabs', () => {
  for (const footer of ['cue', 'meet', 'encode', 'run', 'look'] as const) {
    for (const key of ['1', '2', '3']) {
      const action = resolve(key, { screen: 'card', footer, sayOpen: true }, { repeat: true });
      assert.deepEqual(action, SWALLOW, `held ${key} on ${footer}`);
    }
  }
  for (const key of ['1', '2', '3']) {
    assert.deepEqual(resolve(key, CUE), SWALLOW, `${key} on a cue`);
    assert.deepEqual(resolve(key, { screen: 'card', footer: 'encode' }), SWALLOW, `${key} while saying it twice`);
    assert.deepEqual(resolve(key, SUMMARY), SWALLOW, `${key} on a summary`);
  }
});

test('in the Meet 1, 2 and 3 or the arrows choose Practice, Passive and Can say it, and nothing once Can say it is closed', () => {
  const choices = [['1', 'practice'], ['ArrowLeft', 'practice'], ['2', 'passive'], ['ArrowDown', 'passive'], ['3', 'say'], ['ArrowRight', 'say']] as const;
  for (const [key, choice] of choices) assert.deepEqual(resolve(key, MEET), { type: 'choose', choice }, key);
  // After a hint: 3 and → are still the session's, but choose nothing.
  assert.deepEqual(resolve('3', { ...MEET, sayOpen: false }), SWALLOW);
  assert.deepEqual(resolve('ArrowRight', { ...MEET, sayOpen: false }), SWALLOW);
  assert.deepEqual(resolve('1', { ...MEET, sayOpen: false }), { type: 'choose', choice: 'practice' });
  assert.deepEqual(resolve('ArrowLeft', MEET, { repeat: true }), SWALLOW, 'a held arrow chooses once');
  assert.deepEqual(resolve('2', { ...MEET, undoing: true }), SWALLOW, 'an undo is bringing its card back');
  assert.equal(resolve(' ', MEET), null, 'Space has nothing to press while a choice waits');
  assert.equal(resolve('Enter', MEET), null);
});

test('in a run 1 is Not yet and 3 Got it; Enter is Got it too, except as the second press of a double press', () => {
  assert.deepEqual(resolve('1', RUN), { type: 'answer', gotIt: false });
  assert.deepEqual(resolve('3', RUN), { type: 'answer', gotIt: true });
  assert.deepEqual(resolve('2', RUN), SWALLOW, 'a run has two answers');
  assert.deepEqual(resolve('Enter', RUN), { type: 'answer', gotIt: true });
  assert.deepEqual(resolve('Enter', { ...RUN, justRevealed: true }), SWALLOW, 'within 350 ms of the reveal');
  assert.equal(resolve(' ', RUN), null, 'Space reveals, and never answers');
  assert.equal(resolve('Enter', { ...RUN, onControl: true }), null, 'a focused button presses itself');
  assert.deepEqual(resolve('3', { ...RUN, undoing: true }), SWALLOW);
  assert.deepEqual(resolve('Enter', { ...RUN, undoing: true }), SWALLOW);
  assert.equal(resolve('Enter', RUN, { repeat: true }), null, 'a held Enter answers once');
});

test('Space or Enter moves on from saying an item twice and from the last look, unless an undo is under way', () => {
  for (const footer of ['encode', 'look'] as const) {
    assert.deepEqual(resolve(' ', { screen: 'card', footer }), { type: 'next' }, `Space on ${footer}`);
    assert.deepEqual(resolve('Enter', { screen: 'card', footer }), { type: 'next' }, `Enter on ${footer}`);
    assert.deepEqual(resolve(' ', { screen: 'card', footer, undoing: true }), SWALLOW);
  }
  assert.deepEqual(resolve(' ', { ...CUE, undoing: true }), SWALLOW, 'nor reveals');
});

test('P says the answer again and E plays its example, once the answer shows', () => {
  for (const footer of ['meet', 'encode', 'run', 'look'] as const) {
    assert.deepEqual(resolve('p', { screen: 'card', footer }), { type: 'play' }, `P on ${footer}`);
    assert.deepEqual(resolve('e', { screen: 'card', footer, hasExample: true }), { type: 'example' }, `E on ${footer}`);
    assert.equal(resolve('e', { screen: 'card', footer, hasExample: false }), null, 'a sentence, or a word without an example');
  }
  assert.equal(resolve('p', { ...RUN, undoing: true }), null);
  assert.equal(resolve('p', RUN, { repeat: true }), null);
});

test('U takes back the last review, or the last choice in the Meet, while there is one and no undo is under way', () => {
  assert.deepEqual(resolve('u', { ...RUN, canUndo: true }), { type: 'undo' });
  assert.deepEqual(resolve('U', { ...MEET, canUndo: true }), { type: 'undo' });
  assert.deepEqual(resolve('u', { ...CUE, canUndo: true }), { type: 'undo' }, 'on the next card\'s cue');
  assert.equal(resolve('u', RUN), null, 'nothing to take back');
  assert.equal(resolve('u', { ...RUN, canUndo: true, undoing: true }), null);
  assert.equal(resolve('u', { ...RUN, canUndo: true }, { repeat: true }), null);
});

test('⌘Z on a Mac, Ctrl+Z elsewhere, undoes like U, but leaves the app\'s undo pill its own ⌘Z', () => {
  const card = { ...RUN, canUndo: true };
  assert.deepEqual(resolve('z', card, { metaKey: true }), { type: 'undo' });
  assert.deepEqual(resolve('Z', card, { metaKey: true }), { type: 'undo' }, 'with Caps Lock on');
  assert.equal(resolve('z', card, { ctrlKey: true }), null, 'Ctrl+Z on a Mac is not undo');
  assert.deepEqual(resolve('z', { ...card, isMac: false }, { ctrlKey: true }), { type: 'undo' });
  assert.equal(resolve('z', { ...card, isMac: false }, { metaKey: true }), null);
  assert.equal(resolve('z', card, { metaKey: true, shiftKey: true }), null, 'redo');
  assert.equal(resolve('z', { ...card, appUndoOpen: true }, { metaKey: true }), null, 'the pill takes back what it offers');
  assert.deepEqual(resolve('u', { ...card, appUndoOpen: true }), { type: 'undo' }, 'U stays the session\'s');
  assert.equal(resolve('z', { ...card, canUndo: false }, { metaKey: true }), null);
  assert.equal(resolve('z', { ...card, undoing: true }, { metaKey: true }), null);
  assert.equal(resolve('z', card, { metaKey: true, repeat: true }), null);
  assert.deepEqual(resolve('z', { ...SUMMARY }, { metaKey: true }), { type: 'undo' }, 'on a summary too');
  for (const key of ['1', 'r', 'Enter', 'h']) assert.equal(resolve(key, card, { metaKey: true }), null, `⌘${key} is the browser's`);
});

test('on a summary Enter presses its primary button, R resumes a session ended early and U undoes the last answer', () => {
  assert.deepEqual(resolve('Enter', SUMMARY), { type: 'primary' });
  assert.equal(resolve('Enter', { ...SUMMARY, hasPrimary: false }), null);
  assert.equal(resolve('Enter', { ...SUMMARY, onControl: true }), null, 'a focused button presses itself');
  assert.deepEqual(resolve('r', SUMMARY), { type: 'resume' });
  assert.equal(resolve('r', { ...SUMMARY, canResume: false }), null, 'a finished session');
  assert.deepEqual(resolve('u', SUMMARY), { type: 'undo' });
  assert.equal(resolve(' ', SUMMARY), null);
  assert.equal(resolve('h', SUMMARY), null);
  assert.equal(resolve('Enter', SUMMARY, { repeat: true }), null);
});

test('a key already handled, with Alt, in a text field or under a dialog outside Today is left alone', () => {
  for (const [state, key] of [[PLAN, 'Enter'], [CUE, ' '], [MEET, '1'], [RUN, '3'], [SUMMARY, 'r']] as const) {
    assert.equal(resolve(key, state, { defaultPrevented: true }), null, `${key}: handled`);
    assert.equal(resolve(key, state, { altKey: true }), null, `${key}: with Alt`);
    assert.equal(resolve(key, { ...state, typing: true }), null, `${key}: typing`);
    assert.equal(resolve(key, { ...state, dialogOutside: true }), null, `${key}: a dialog has the keys`);
  }
});
