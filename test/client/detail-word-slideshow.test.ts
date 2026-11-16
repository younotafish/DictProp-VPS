import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ItemGroup, StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { useCardNavigation } from '../../views/detail/useCardNavigation.ts';
import { useWordSlideshow } from '../../views/detail/useWordSlideshow.ts';

// The word slideshow (views/detail/useWordSlideshow.ts), driven as the word card drives it, with useCardNavigation
// following the card on screen. It renders in a component that draws nothing, with just enough of a browser for React,
// as in detail-card-navigation.test.ts, and the slides' timer is mocked.

const SLIDE_MS = 1_000;

const card = (id: string): StoredItem => ({
  type: 'vocab',
  data: { id, word: id.split(':')[0], examples: [] } as Partial<VocabCard> as VocabCard,
  savedAt: 1,
  srs: SRSAlgorithm.createNew(id, 'vocab', 0),
});
const group = (...items: StoredItem[]): ItemGroup => ({ title: items[0].data.id.split(':')[0], items });

interface ViewProps {
  groups: ItemGroup[];
  initialGroupIndex: number;
}

async function slideshowHarness() {
  const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown, querySelector: () => null });
  const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
  page.defaultView = browser;
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  // Stable across renders, as the word card's ref and useAutoPlay's callback are.
  const scrollContainerRef = { current: null };
  const autoPlaySpeedRef = { current: SLIDE_MS };
  let stopped = 0;
  const stopSlideshow = () => { stopped++; };
  let shown = '';
  const View = ({ groups, initialGroupIndex }: ViewProps) => {
    const navigation = useCardNavigation(groups, {
      initialGroupIndex, initialItemIndex: 0, navigationKey: undefined, scrollContainerRef, sentenceReview: false,
    });
    useWordSlideshow({
      isAutoPlaying: true, stopSlideshow, groups, currentGroupIndex: navigation.currentGroupIndex,
      currentItemIndex: navigation.currentItemIndex, setCurrentGroupIndex: navigation.setCurrentGroupIndex,
      setCurrentItemIndex: navigation.setCurrentItemIndex, autoPlaySpeedRef, title: '', shownKey: navigation.shownKey,
    });
    shown = navigation.currentItem.data.id;
    return null;
  };
  return {
    /** The card on screen, and how often the slideshow has ended. */
    shown: () => shown,
    stopped: () => stopped,
    show: (props: ViewProps) => act(() => root.render(createElement(View, props))),
    close: async () => {
      await act(() => root.unmount());
      delete globals.window;
      delete globals.document;
      delete globals.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

test('the slideshow shows each meaning in turn, a word with one meaning twice, and ends after the last card', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = await slideshowHarness();
  try {
    await view.show({ groups: [group(card('bank:1'), card('bank:2')), group(card('cat'))], initialGroupIndex: 0 });
    const slides = [view.shown()];
    for (let turn = 0; turn < 3; turn++) {
      await act(() => t.mock.timers.tick(SLIDE_MS));
      slides.push(view.shown());
    }
    assert.deepEqual(slides, ['bank:1', 'bank:2', 'cat', 'cat']);
    assert.equal(view.stopped(), 0);
    await act(() => t.mock.timers.tick(SLIDE_MS));
    assert.equal(view.stopped(), 1);
  } finally {
    await view.close();
  }
});

test('a one-meaning word on its second turn moves on when a word before it leaves the view, rather than taking a third', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = await slideshowHarness();
  try {
    const [a, b, c] = ['a', 'b', 'c'].map(id => group(card(id)));
    await view.show({ groups: [a, b, c], initialGroupIndex: 1 });
    await act(() => t.mock.timers.tick(SLIDE_MS));
    assert.equal(view.shown(), 'b', 'its second turn');
    // Another device deletes "a": App takes it out of the view, and "b" moves up.
    await view.show({ groups: [b, c], initialGroupIndex: 1 });
    assert.equal(view.shown(), 'b');
    await act(() => t.mock.timers.tick(SLIDE_MS));
    assert.equal(view.shown(), 'c');
  } finally {
    await view.close();
  }
});
