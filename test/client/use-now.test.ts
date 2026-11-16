import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Activity, act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useNow } from '../../hooks/useNow.ts';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 15, 21);

// Just enough of a browser for React to render a screen that draws nothing, and the page's visibility.
const page = Object.assign(new EventTarget(), {
  nodeType: 9, visibilityState: 'visible' as DocumentVisibilityState, activeElement: null, defaultView: null as unknown,
});
const browser = { document: page, event: undefined, HTMLIFrameElement: class {} };
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;
before(() => Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true }));
after(() => {
  delete globals.window;
  delete globals.document;
  delete globals.IS_REACT_ACT_ENVIRONMENT;
});

const resumePage = () => act(() => {
  page.visibilityState = 'hidden';
  page.dispatchEvent(new Event('visibilitychange'));
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
});

// A tab as App shows one, in an <Activity>, whose screen counts what's due from useNow(reviews).
async function openTab(reviews: unknown) {
  const times: number[] = [];
  const Screen = ({ reviews: key }: { reviews: unknown }) => {
    times.push(useNow(key));
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  const render = (shown: boolean, key: unknown) => act(() => {
    root.render(createElement(Activity, { mode: shown ? 'visible' : 'hidden', children: createElement(Screen, { reviews: key }) }));
  });
  await render(true, reviews);
  return {
    render,
    /** The time the screen last counted from. */
    now: () => times[times.length - 1],
    renders: () => times.length,
    close: () => act(() => root.unmount()),
  };
}

test('a tab shown again counts from the time it is shown, though the page came back into view on another tab', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const reviews = {};
  const tab = await openTab(reviews);
  assert.equal(tab.now(), START);
  assert.equal(tab.renders(), 1, 'the first showing is a single render');

  // Left on another tab overnight; the app comes back to the foreground there, then the tab is opened.
  await tab.render(false, reviews);
  t.mock.timers.tick(10 * HOUR);
  await resumePage();
  await tab.render(true, reviews);
  assert.equal(tab.now(), START + 10 * HOUR);

  // A plain return to the tab counts as well, after a render while hidden too.
  await tab.render(false, reviews);
  await tab.render(false, reviews);
  t.mock.timers.tick(HOUR);
  await tab.render(true, reviews);
  assert.equal(tab.now(), START + 11 * HOUR);
  await tab.close();
});

test('a tab on screen counts from the same time until its reviews change or the page comes back into view', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const reviews = {};
  const tab = await openTab(reviews);

  t.mock.timers.tick(HOUR);
  await tab.render(true, reviews);
  assert.equal(tab.now(), START, "it doesn't tick while the tab is watched");

  await resumePage();
  assert.equal(tab.now(), START + HOUR);

  t.mock.timers.tick(HOUR);
  await tab.render(true, {});
  assert.equal(tab.now(), START + 2 * HOUR);
  await tab.close();
});
