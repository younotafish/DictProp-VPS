import assert from 'node:assert/strict';
import test from 'node:test';
import { openOverlay, takeOverlayOpener } from '../../components/overlayStack.ts';

// The stack only reads document.activeElement and document.body.
class FakeElement { isConnected = true; constructor(readonly name: string) {} }
const body = new FakeElement('body');
const fakeDocument = { body, activeElement: body as FakeElement | null };
(globalThis as { document?: unknown }).document = fakeDocument;
const focus = (element: FakeElement | null) => { fakeDocument.activeElement = element; };

test('the first overlay records its opener, and overlays opened over it keep that one', () => {
  const button = new FakeElement('button');
  focus(button);
  const closeCard = openOverlay();
  focus(new FakeElement('delete button in the card'));
  const closeDialog = openOverlay();
  closeDialog();
  closeCard();

  assert.equal(takeOverlayOpener(), button);
  assert.equal(takeOverlayOpener(), null, 'reading the opener clears it');
});

test('an overlay opened with focus on the body, or on a removed element, keeps the opener it would replace', () => {
  const button = new FakeElement('button');
  focus(button);
  const closeCard = openOverlay();
  // The card closes and a popup opens in the same commit: the card took focus with it.
  closeCard();
  focus(body);
  const closePopup = openOverlay();
  closePopup();
  assert.equal(takeOverlayOpener(), button);

  focus(button);
  openOverlay()();
  const removed = new FakeElement('removed');
  removed.isConnected = false;
  focus(removed);
  openOverlay()();
  focus(null);
  openOverlay()();
  assert.equal(takeOverlayOpener(), button);
});

test('closing an overlay twice counts once, so the next overlay still records its opener', () => {
  focus(new FakeElement('first'));
  const close = openOverlay();
  close();
  close();
  takeOverlayOpener();

  const second = new FakeElement('second');
  focus(second);
  const closeSecond = openOverlay();
  focus(new FakeElement('inside'));
  const closeNested = openOverlay();
  closeNested();
  closeNested();
  // Still one overlay open, so a third doesn't count as the first.
  focus(new FakeElement('third'));
  const closeThird = openOverlay();
  closeThird();
  closeSecond();
  assert.equal(takeOverlayOpener(), second);
});
