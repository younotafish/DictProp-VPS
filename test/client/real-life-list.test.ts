import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useRealLifeList } from '../../views/reading/useRealLifeList.ts';

// views/reading/useRealLifeList.ts: what narrows a Real Life collection's list, and the clock its rows count from.

const NOW = Date.UTC(2026, 10, 16, 9);
const MINUTE = 60_000;

// Just enough of a browser for React to mount a component that draws nothing (as in reading-clock.test.ts).
const page = Object.assign(new EventTarget(), {
  nodeType: 9, visibilityState: 'visible' as DocumentVisibilityState, activeElement: null, defaultView: null as unknown,
});
const browser = { document: page, event: undefined, HTMLIFrameElement: class {} };
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;

test('a collection takes the time as it opens, and again on a new theme, review chip or settled search and when a sentence opens, not on a sync', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  try {
    let list: ReturnType<typeof useRealLifeList> | undefined;
    const List = (_props: { progress: number }) => {
      list = useRealLifeList();
      return null;
    };
    const container = Object.assign(new EventTarget(), {
      nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
    });
    const root = createRoot(container as unknown as Element);
    const shown = () => list!;
    await act(() => root.render(createElement(List, { progress: 1 })));
    assert.deepEqual(shown().scope, { sectionId: 'all', reviewFilter: 'all', query: '' }, 'every collection opens on All');
    assert.equal(shown().now, NOW);

    // A line reviewed yesterday at 9:20 falls due at 9:20. At 9:40 progress arrives from a sync: the rows hold still.
    t.mock.timers.tick(40 * MINUTE);
    await act(() => root.render(createElement(List, { progress: 2 })));
    assert.equal(shown().now, NOW);

    // The Due chip then lists that line as due.
    await act(() => shown().setReviewFilter('due'));
    assert.equal(shown().now, NOW + 40 * MINUTE);

    t.mock.timers.tick(MINUTE);
    await act(() => shown().setSectionId('rapport-and-small-talk'));
    assert.equal(shown().now, NOW + 41 * MINUTE, 'a theme');

    t.mock.timers.tick(MINUTE);
    await act(() => shown().setQuery('  weekend'));
    assert.deepEqual(shown().scope, { sectionId: 'rapport-and-small-talk', reviewFilter: 'due', query: 'weekend' });
    assert.equal(shown().now, NOW + 42 * MINUTE, 'the search, once it settles');

    t.mock.timers.tick(MINUTE);
    await act(() => shown().setQuery('  weekend '));
    assert.equal(shown().query, '  weekend ', 'the box keeps what was typed');
    assert.equal(shown().now, NOW + 42 * MINUTE, 'spaces around the search change nothing');

    await act(() => shown().noteOpened());
    assert.equal(shown().now, NOW + 43 * MINUTE, 'a sentence opening over the list');
    await act(() => root.unmount());
  } finally {
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  }
});
