import assert from 'node:assert/strict';
import test from 'node:test';
import { hasEscapeLayerAbove, pushEscapeLayer } from '../../components/escapeStack.ts';

// The stack only needs the window's listener API, which Node's EventTarget provides.
const fakeWindow = new EventTarget();
(globalThis as { window?: unknown }).window = fakeWindow;

const press = (key: string, isComposing = false) => {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key, isComposing });
  fakeWindow.dispatchEvent(event);
  return event;
};

test('Escape closes only the newest layer, then the one beneath it', () => {
  const closed: string[] = [];
  const popSheet = pushEscapeLayer(() => closed.push('sheet'), 55);
  const popPopup = pushEscapeLayer(() => closed.push('popup'), 100);
  const popDialog = pushEscapeLayer(() => closed.push('dialog'), 100);

  const event = press('Escape');
  assert.deepEqual(closed, ['dialog']);
  assert.equal(event.defaultPrevented, true);

  popDialog();
  press('Escape');
  popPopup();
  press('Escape');
  popSheet();
  assert.deepEqual(closed, ['dialog', 'popup', 'sheet']);
});

test('a layer opened beneath a higher one waits its turn', () => {
  const closed: string[] = [];
  const popPopup = pushEscapeLayer(() => closed.push('popup'), 100);
  // The search sheet slides in under the review popup that asked for a search.
  const popSheet = pushEscapeLayer(() => closed.push('sheet'), 55);

  press('Escape');
  assert.deepEqual(closed, ['popup']);
  popPopup();
  press('Escape');
  assert.deepEqual(closed, ['popup', 'sheet']);
  popSheet();
});

test('the views beneath never see an Escape a layer took, and see it again once every layer closed', () => {
  const seen: string[] = [];
  const pop = pushEscapeLayer(() => seen.push('layer'));
  const view = (e: Event) => seen.push(`view:${(e as KeyboardEvent).key}`);
  fakeWindow.addEventListener('keydown', view);

  press('Escape');
  press('ArrowLeft');
  assert.deepEqual(seen, ['layer', 'view:ArrowLeft']);

  pop();
  pop(); // closing twice is harmless
  const event = press('Escape');
  assert.deepEqual(seen, ['layer', 'view:ArrowLeft', 'view:Escape']);
  assert.equal(event.defaultPrevented, false);
  fakeWindow.removeEventListener('keydown', view);
});

test('Escape mid-composition is left to the input method', () => {
  let closes = 0;
  const pop = pushEscapeLayer(() => { closes++; });
  const event = press('Escape', true);
  assert.equal(closes, 0);
  assert.equal(event.defaultPrevented, false);
  pop();
});

test('a layer knows when one above it is open, but not one that opened beneath it', () => {
  const popView = pushEscapeLayer(() => {}, 50);
  const popSheet = pushEscapeLayer(() => {}, 55);
  assert.equal(hasEscapeLayerAbove(55), false, 'the card view beneath and the sheet itself do not count');

  const popPopup = pushEscapeLayer(() => {}, 100);
  assert.equal(hasEscapeLayerAbove(55), true, 'a review popup over the sheet');
  assert.equal(hasEscapeLayerAbove(100), false, 'nothing above the popup');
  popPopup();
  assert.equal(hasEscapeLayerAbove(55), false, 'the popup closed');

  popSheet();
  popView();
  assert.equal(hasEscapeLayerAbove(0), false, 'no layer open');
});
