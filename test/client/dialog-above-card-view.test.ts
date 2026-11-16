import assert from 'node:assert/strict';
import test from 'node:test';
import { pushEscapeLayer } from '../../components/escapeStack.ts';
import { CARD_VIEW_LAYER, isDialogAboveCardView } from '../../views/detail/dialogAbove.ts';

// views/detail/dialogAbove.ts: when a dialog outside the card view takes the view's keys.

// The dialogs come from the document (a fake lists them, all showing) and the layers from the escape stack, whose
// listener needs a window.
const showing = { getClientRects: () => ({ length: 1 }) };
(globalThis as { document?: unknown }).document = { querySelectorAll: () => [showing] };
(globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {} };
const view = { contains: () => false } as unknown as Element;

test('a dialog in a layer above the card view takes its keys', () => {
  const closeView = pushEscapeLayer(() => {}, CARD_VIEW_LAYER);
  for (const [name, z] of [['the search results', 55], ['the card popup or a dialog', 100]] as const) {
    const close = pushEscapeLayer(() => {}, z);
    assert.equal(isDialogAboveCardView(view), true, name);
    close();
  }
  closeView();
});

test('a tool sheet beneath the card view leaves the keys to the view', () => {
  const closeSheet = pushEscapeLayer(() => {}, 45);
  const closeView = pushEscapeLayer(() => {}, CARD_VIEW_LAYER);
  assert.equal(isDialogAboveCardView(view), false);
  closeView();
  closeSheet();
});

test('with no dialog outside the view, a layer above changes nothing', () => {
  const close = pushEscapeLayer(() => {}, 100);
  assert.equal(isDialogAboveCardView({ contains: () => true } as unknown as Element), false, 'the dialog is the view\'s own');
  close();
});
