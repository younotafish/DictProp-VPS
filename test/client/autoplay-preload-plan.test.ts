import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { PreloadCard, PreloadPlan } from '../../services/audio/autoplayPreload.ts';
import { chooseTtsStyle, setTtsStyle } from '../../services/ttsSettings.ts';
import { useAutoplayPreloadPlan } from '../../views/detail/useAutoplayPreloadPlan.ts';

// views/detail/useAutoplayPreloadPlan.ts: when sentence auto-play plans its preload again. The hook renders in a
// component that draws nothing, with just enough of a browser for React, as in detail-gone-items.test.ts.

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

/** Sentence review from a sentence that keeps Clear as its own voice, then one without a voice of its own, then one with. */
const CARDS: PreloadCard[] = [
  { id: 'on-screen', texts: ['The sentence on screen.'], preferredStyle: 'clear' },
  { id: 'next', texts: ['The next sentence.'] },
  { id: 'own-voice', texts: ['A sentence with a voice of its own.'], preferredStyle: 'clear' },
];

async function runningAutoPlay() {
  const plans: Array<PreloadPlan | null> = [];
  const Probe = () => {
    plans.push(useAutoplayPreloadPlan({
      active: true, getCards: () => CARDS, position: 0, timerMinutes: 20, repeats: 1, gapMs: 2000, cardGapMs: 2000,
      remainingMs: () => 0,
    }));
    return null;
  };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  await act(() => root.render(createElement(Probe)));
  return { plan: () => plans[plans.length - 1], close: () => act(() => root.unmount()) };
}

const voices = (plan: PreloadPlan | null) => plan?.clips.map(clip => clip.style);

test('a click on Clear or Casual anywhere plans the voices again from the sentence on screen; a sentence\'s own voice coming up doesn\'t', async () => {
  setTtsStyle('clear');
  const autoPlay = await runningAutoPlay();
  try {
    assert.deepEqual(voices(autoPlay.plan()), ['clear', 'clear', 'clear']);
    // A click in the review popup over the lesson, which writes nothing on the sentence: it now reads in Casual, and so
    // does the next one, until the sentence with a voice of its own.
    await act(() => chooseTtsStyle('casual'));
    assert.deepEqual(voices(autoPlay.plan()), ['casual', 'casual', 'clear']);
    const planned = autoPlay.plan();
    await act(() => setTtsStyle('clear'));
    assert.equal(autoPlay.plan(), planned, 'the switch to a sentence\'s own voice is part of the plan already');
  } finally {
    await autoPlay.close();
    setTtsStyle('clear');
  }
});
