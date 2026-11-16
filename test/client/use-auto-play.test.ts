import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PAUSE_CAP_MS } from '../../services/audio/autoplayController.ts';
import { useAutoPlay } from '../../views/detail/useAutoPlay.ts';

// views/detail/useAutoPlay.ts: the card view's two auto-play modes and their timer. The hook renders in a component
// that draws nothing, with just enough of a browser for React, as in detail-gone-items.test.ts.

const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown });
const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
page.defaultView = browser;
const globals = globalThis as Record<string, unknown>;
before(() => Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true }));
after(() => {
  delete globals.window;
  delete globals.document;
  delete globals.IS_REACT_ACT_ENVIRONMENT;
});

/** A card view's auto-play: `autoPlay()` is what the hook returned on the last render. */
async function cardView() {
  let latest: ReturnType<typeof useAutoPlay> | undefined;
  const Probe = () => {
    latest = useAutoPlay();
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  await act(() => root.render(createElement(Probe)));
  return {
    autoPlay: () => {
      assert.ok(latest, 'rendered');
      return latest;
    },
    close: () => act(() => root.unmount()),
  };
}

test('a pause that lasts 15 minutes ends sentence auto-play as the end of the Duration does; a shorter one doesn\'t', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const view = await cardView();
  try {
    await act(() => view.autoPlay().toggleSentenceAutoPlay());
    let ended = 0;
    view.autoPlay().setTimerExpiry(() => { ended++; });

    await act(() => view.autoPlay().setSentenceAutoPlayPaused(true));
    t.mock.timers.tick(PAUSE_CAP_MS - 1_000);
    await act(() => view.autoPlay().setSentenceAutoPlayPaused(false));
    t.mock.timers.tick(1_000);
    assert.equal(ended, 0, 'resumed short of the cap');

    await act(() => view.autoPlay().setSentenceAutoPlayPaused(true));
    t.mock.timers.tick(PAUSE_CAP_MS - 1_000);
    assert.equal(ended, 0, 'paused a second short of the cap');
    assert.equal(view.autoPlay().countdownFrozenMs, 20 * 60_000 - 1_000, 'the Duration counted only the second between pauses');
    t.mock.timers.tick(1_000);
    assert.equal(ended, 1, 'the reading is told to end, as when the Duration runs out');

    // With nothing registered to end it, auto-play stops itself.
    view.autoPlay().setTimerExpiry(null);
    await act(() => t.mock.timers.tick(1_000));
    assert.equal(view.autoPlay().isSentenceAutoPlaying, false);
  } finally {
    await view.close();
  }
});
