import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { openOverlay } from '../../components/overlayStack.ts';
import { useReadingEscape } from '../../views/reading/useReadingEscape.ts';

// views/reading/useReadingEscape.ts, the Esc of an essay and of a Real Life collection.

// Just enough of a browser for React to mount a component that draws nothing (as in reading-clock.test.ts), and a
// window for the escape stack's listener.
const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;

/** Esc as the page hears it: App's own Escape, which closes a card or popup, leaves one a layer prevented alone. */
const pressEscape = () => {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  browser.dispatchEvent(event);
  return event;
};

test('a reading screen\'s Esc goes back while nothing covers it, and is left to App while a card or popup covers it, loaded or not', async () => {
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  try {
    const backs: string[] = [];
    const Screen = () => {
      useReadingEscape(() => backs.push('back'));
      return null;
    };
    const container = Object.assign(new EventTarget(), {
      nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
    });
    const root = createRoot(container as unknown as Element);
    await act(() => root.render(createElement(Screen)));

    assert.equal(pressEscape().defaultPrevented, true);
    assert.deepEqual(backs, ['back']);

    // App registers a card or the word popup as an overlay from the moment it opens: behind its loading spinner, and on
    // its crash screen, it has no escape layer yet. Esc then goes past the screen to App, which closes it.
    let closeOverlay = () => {};
    await act(() => { closeOverlay = openOverlay(); });
    assert.equal(pressEscape().defaultPrevented, false, 'App hears it');
    assert.deepEqual(backs, ['back'], 'the screen stays open underneath');

    await act(() => closeOverlay());
    assert.equal(pressEscape().defaultPrevented, true);
    assert.deepEqual(backs, ['back', 'back'], 'with nothing over it, Esc goes back again');
    await act(() => root.unmount());
    assert.equal(pressEscape().defaultPrevented, false, 'a closed screen leaves Esc alone');
  } finally {
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
});
