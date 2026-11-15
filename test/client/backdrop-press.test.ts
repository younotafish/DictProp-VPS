import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackdropPress } from '../../components/backdropPress.ts';

// Stand-ins for the backdrop and an element inside the dialog panel.
const backdrop = { name: 'backdrop' } as unknown as EventTarget;
const insidePanel = { name: 'selected text' } as unknown as EventTarget;
const on = (target: EventTarget) => ({ target, currentTarget: backdrop });

test('a press and release on the backdrop is a click outside', () => {
  const press = createBackdropPress();
  press.press(on(backdrop));
  assert.equal(press.isClickOutside(on(backdrop)), true);
});

test('a press that began inside the dialog is not, though its click lands on the backdrop', () => {
  const press = createBackdropPress();
  // A text selection dragged out of the panel: the browser sends the click to the backdrop, the nearest
  // element holding both ends.
  press.press(on(insidePanel));
  assert.equal(press.isClickOutside(on(backdrop)), false);
  // The next press on the backdrop closes as usual.
  press.press(on(backdrop));
  assert.equal(press.isClickOutside(on(backdrop)), true);
});

test('a click the backdrop saw no press for is not, and each press counts for one click', () => {
  const press = createBackdropPress();
  // The press began before the dialog opened, or the click came from no pointer at all.
  assert.equal(press.isClickOutside(on(backdrop)), false);
  press.press(on(backdrop));
  assert.equal(press.isClickOutside(on(backdrop)), true);
  assert.equal(press.isClickOutside(on(backdrop)), false, 'a second click without a new press');
});

test('a click aimed inside the dialog is not, wherever its press began', () => {
  const press = createBackdropPress();
  press.press(on(backdrop));
  assert.equal(press.isClickOutside(on(insidePanel)), false);
});
