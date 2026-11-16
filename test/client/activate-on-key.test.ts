import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeyboardEvent } from 'react';
import { activateOnEnterOrSpace, isActivationKey, type KeyPress } from '../../components/activateOnKey.ts';

const row = { id: 'row' } as unknown as EventTarget;
const childButton = { id: 'reviewed' } as unknown as EventTarget;
const press = (key: string, overrides: Partial<KeyPress> = {}): KeyPress => ({ key, repeat: false, target: row, currentTarget: row, ...overrides });

test('Enter and Space pressed on the row itself activate it; anything else does not', () => {
  const table: Array<[KeyPress, boolean, string]> = [
    [press('Enter'), true, 'Enter'],
    [press(' '), true, 'Space'],
    [press('Enter', { repeat: true }), false, 'a held Enter repeating'],
    [press(' ', { repeat: true }), false, 'a held Space repeating'],
    [press('Enter', { target: childButton }), false, 'Enter on a button inside the row is the button\'s'],
    [press(' ', { target: childButton }), false, 'Space on a button inside the row is the button\'s'],
    [press('Escape'), false, 'Escape'],
    [press('ArrowDown'), false, 'an arrow'],
    [press('Tab'), false, 'Tab'],
    [press('e'), false, 'a letter'],
  ];
  for (const [event, expected, name] of table) assert.equal(isActivationKey(event), expected, name);
});

/** A fake keydown that records what the handler did with it, in order. */
function keydown(key: string, overrides: Partial<KeyPress> = {}) {
  const calls: string[] = [];
  const event = {
    ...press(key, overrides),
    preventDefault: () => calls.push('preventDefault'),
    stopPropagation: () => calls.push('stopPropagation'),
  } as unknown as KeyboardEvent<HTMLDivElement>;
  return { event, calls };
}

test('an activating press is taken (no scroll, no window listener) and then opens the row, once', () => {
  for (const key of ['Enter', ' ']) {
    const { event, calls } = keydown(key);
    const handler = activateOnEnterOrSpace<HTMLDivElement>(() => calls.push('activate'));
    handler(event);
    assert.deepEqual(calls, ['preventDefault', 'stopPropagation', 'activate'], JSON.stringify(key));
  }
});

test('a press that does not activate the row is left alone entirely', () => {
  for (const [key, overrides] of [['Enter', { repeat: true }], [' ', { target: childButton }], ['Escape', {}], ['a', {}]] as const) {
    const { event, calls } = keydown(key, overrides);
    activateOnEnterOrSpace<HTMLDivElement>(() => calls.push('activate'))(event);
    assert.deepEqual(calls, [], `${JSON.stringify(key)} ${JSON.stringify(overrides)}`);
  }
});
