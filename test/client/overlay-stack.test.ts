import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { openOverlay, takeOverlayOpener, useFocusBackWhenUncovered } from '../../components/overlayStack.ts';

// The stack only reads document.activeElement and document.body, and asks the element with focus whether it's in an
// inert part of the page.
class FakeElement {
  isConnected = true;
  inInertPart = false;
  constructor(readonly name: string) {}
  closest(selector: string) { return selector === '[inert]' && this.inInertPart ? this : null; }
}
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

test('a part the card view covered gives its dialog the focus the card took away, and leaves focus that stayed alone', async () => {
  // Just enough of a browser for React to mount a component that draws nothing, as in overlays.test.ts.
  const page = Object.assign(new EventTarget(), { nodeType: 9, body, activeElement: body as FakeElement | null, defaultView: null as unknown });
  const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
  page.defaultView = browser;
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  // The sheets slot, holding Batch import's sheet.
  let focused = 0;
  const sheet = { focus: (options?: FocusOptions) => { assert.deepEqual(options, { preventScroll: true }); focused++; } };
  const slot = { querySelector: (selector: string) => (selector === '[role="dialog"]' ? sheet : null) };
  const readSlot = () => slot as unknown as HTMLElement;
  const Shell = ({ covered }: { covered: boolean }) => {
    useFocusBackWhenUncovered(covered, readSlot);
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  const show = (covered: boolean) => act(() => root.render(createElement(Shell, { covered })));
  /** Opens the card view, puts focus where `focusAfter` says once it's open, closes it, and counts the sheet's focus calls. */
  const coverWith = async (focusAfter: FakeElement | null): Promise<number> => {
    const before = focused;
    await show(true);
    page.activeElement = focusAfter;
    await show(true);
    assert.equal(focused, before, 'nothing moves while the card is open');
    await show(false);
    return focused - before;
  };
  try {
    await show(false);
    assert.equal(focused, 0, 'nothing covered it yet');
    assert.equal(await coverWith(body), 1, 'the card took focus with it: the sheet has it');
    const gone = new FakeElement('the card\'s close button');
    gone.isConnected = false;
    assert.equal(await coverWith(gone), 1, 'on an element taken off the page');
    const inert = new FakeElement('a control in the inert page');
    inert.inInertPart = true;
    assert.equal(await coverWith(inert), 1, 'in an inert part of the page');
    assert.equal(await coverWith(null), 1, 'nowhere at all');
    assert.equal(await coverWith(new FakeElement('the search button')), 0, 'focus on a control still there stays put');
  } finally {
    await act(() => root.unmount());
    globals.document = fakeDocument;
    delete globals.window;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
});
