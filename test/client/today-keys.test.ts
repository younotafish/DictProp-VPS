import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTodayKey, type TodayKeyAction, type TodayKeyEvent, type TodayKeyState } from '../../views/today/todayKeys.ts';

// Today's one key (views/today/todayKeys.ts), as TodayView asks the table with the DOM facts it reads while the plan
// shows. A key the table returns null for is left to the rest of the app (the tab keys, the browser's chords).

const PLAN: TodayKeyState = { hasPrimary: true, typing: false, onControl: false, dialogOutside: false };

const press = (key: string, event: Partial<TodayKeyEvent> = {}): TodayKeyEvent => ({
  key, repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...event,
});

const resolve = (key: string, state: Partial<TodayKeyState> = {}, event: Partial<TodayKeyEvent> = {}): TodayKeyAction | null =>
  resolveTodayKey(press(key, event), { ...PLAN, ...state });

test('on the plan Enter presses the unit card\'s primary button, Start unit or Continue, once per press', () => {
  assert.deepEqual(resolve('Enter'), { type: 'primary' });
  assert.deepEqual(resolve('Enter', {}, { shiftKey: true }), { type: 'primary' }, 'Shift changes nothing');
  assert.equal(resolve('Enter', {}, { repeat: true }), null, 'held');
  assert.equal(resolve('Enter', { hasPrimary: false }), null, 'Done for today, or no unit to offer');
  assert.equal(resolve('Enter', { onControl: true }), null, 'a focused button presses itself');
});

test('every other key on the plan, the tab keys among them, is left to the app', () => {
  for (const key of ['1', '2', '3', ' ', 'u', 'h', 'r', 'p', 'b', 'Escape', 'ArrowLeft', 'ArrowRight', 'Tab']) {
    assert.equal(resolve(key), null, `${key} stays the app's`);
  }
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
    assert.equal(resolve('Enter', {}, { [modifier]: true }), null, `${modifier} with Enter is a chord, not the button`);
  }
  assert.equal(resolve('z', {}, { metaKey: true }), null, '⌘Z is the app\'s undo pill\'s');
});

test('a key already handled, in a text field or under a dialog outside Today is left alone', () => {
  assert.equal(resolve('Enter', {}, { defaultPrevented: true }), null, 'handled');
  assert.equal(resolve('Enter', { typing: true }), null, 'typing');
  assert.equal(resolve('Enter', { dialogOutside: true }), null, 'a dialog has the keys');
});
