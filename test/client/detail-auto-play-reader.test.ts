import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ItemGroup, StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import {
  FakeAudioElement, FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, installFakeMediaSession, until,
} from '../support/audio/fakeMedia.ts';

// Sentence auto-play's reading as the card view drives it (views/detail/useAutoPlayReader.ts), following the card on
// screen with useCardNavigation, through the real controller and speech engine. The browser's media and the server's
// clips are faked, as in popup-playback.test.ts, and the window also carries just enough of a browser for React, as in
// detail-card-navigation.test.ts. The reading starts again only when another card or sentence shows: one before the
// one on screen leaving the view, as when another device deletes it, or a new copy of it, as a Got it or a sync brings,
// leaves its reading as it was, paused or not.

installFakeMedia({ userAgent: IPHONE_USER_AGENT });
const page = Object.assign(new EventTarget(), { nodeType: 9, activeElement: null, defaultView: null as unknown, querySelector: () => null });
const browser = Object.assign(new EventTarget(), (globalThis as unknown as { window: object }).window, {
  document: page, event: undefined, HTMLIFrameElement: class {},
});
page.defaultView = browser;
Object.assign(globalThis, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
const lockScreen = installFakeMediaSession();
const server = new FakeTtsServer();
server.install();

const engine = await import('../../services/neuralTts.ts');
const { ttsKey } = await import('../../services/api/tts.ts');
const { useLatest } = await import('../../hooks/useStableValue.ts');
const { useCardNavigation } = await import('../../views/detail/useCardNavigation.ts');
const { useAutoPlayReader } = await import('../../views/detail/useAutoPlayReader.ts');

let texts = 0;
/** A sentence no earlier case has read, with its clip on the server. */
const sentence = async (): Promise<string> => {
  const text = `Sentence ${++texts} is read aloud.`;
  server.clips.set(await ttsKey(text, 'Mia'), new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }));
  return text;
};
const card = (id: string, example: string): StoredItem => ({
  type: 'vocab',
  data: { id, word: id, examples: [example] } as Partial<VocabCard> as VocabCard,
  savedAt: 1,
  srs: SRSAlgorithm.createNew(id, 'vocab', 0),
});
const group = (item: StoredItem): ItemGroup => ({ title: item.data.id, items: [item] });

const state = () => engine.getPlaybackState();
/** The engine's <audio> element, not the silent loop auto-play's keep-alive plays on one of its own. */
const playerElement = () => {
  const element = FakeAudioElement.created.find(candidate => !candidate.loop);
  if (!element) throw new Error('the engine has not created its <audio> element yet');
  return element;
};
/** Waits for the read of `text` to reach the element and start, then puts it halfway through its 4 s. */
const playsHalfway = async (text: string) => {
  const element = playerElement();
  await until(() => state().text === text && element.src.startsWith('blob:') && !element.paused, `${text} plays`);
  element.loadMetadata(4);
  element.startPlaying();
  element.currentTime = 2;
  assert.deepEqual(state(), { text, status: 'playing' });
};

interface ViewProps {
  groups: ItemGroup[];
  /** Sentence review's sentences, one per group, as id and text; the word card reads its cards' examples. */
  sentences?: readonly { id: string; text: string }[];
  initialGroupIndex: number;
}

/**
 * Renders a card view's auto-play in a component that draws nothing: useCardNavigation and the reader, as
 * WordDetailView and SentenceReviewView wire them, with auto-play running from the first render.
 */
async function readerHarness() {
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  // Stable across renders, as the views' refs and useAutoPlay's callbacks are.
  const scrollContainerRef = { current: null };
  const repeatsRef = { current: 1 };
  const gapRef = { current: 2_000 };
  const stop = () => {};
  const paused: boolean[] = [];
  let controls: ReturnType<typeof useAutoPlayReader> | undefined;
  const View = ({ groups, sentences, initialGroupIndex }: ViewProps) => {
    const navigation = useCardNavigation(groups, {
      initialGroupIndex, initialItemIndex: 0, navigationKey: undefined, scrollContainerRef,
      ...(sentences ? { sentenceReview: true as const, sentenceIds: sentences.map(item => item.id) } : { sentenceReview: false as const }),
    });
    const currentGroupIndexRef = useLatest(navigation.currentGroupIndex);
    const text = sentences
      ? sentences[Math.min(navigation.currentGroupIndex, sentences.length - 1)].text
      : (navigation.currentItem.data as VocabCard).examples[0];
    controls = useAutoPlayReader({
      active: true,
      stop,
      repeatsRef,
      gapRef,
      groups,
      currentGroupIndex: navigation.currentGroupIndex,
      currentItemIndex: navigation.currentItemIndex,
      setCurrentGroupIndex: navigation.setCurrentGroupIndex,
      setCurrentItemIndex: navigation.setCurrentItemIndex,
      currentGroupIndexRef,
      shownKey: navigation.shownKey,
      currentItem: navigation.currentItem,
      sentenceReview: !!sentences,
      readCard: () => ({ texts: [text], title: text, artist: 'DictProp' }),
      onPausedChange: next => { paused.push(next); },
    });
    return null;
  };
  return {
    /** Every pause and resume auto-play reported, in turn. */
    paused,
    controls: () => controls!,
    show: (props: ViewProps) => act(() => root.render(createElement(View, props))),
    close: () => act(() => root.unmount()),
  };
}

test.beforeEach(() => { engine.stopCurrent(); });

test('a paused lesson stays paused on its sentence when another sentence of the run leaves it, before or after that sentence', async () => {
  const [one, two, three, four] = await Promise.all([sentence(), sentence(), sentence(), sentence()]);
  const s1 = { id: 's1', text: one }, s2 = { id: 's2', text: two }, s3 = { id: 's3', text: three }, s4 = { id: 's4', text: four };
  // Three sentences of "river" share its source card; the fourth is "apple"'s.
  const river = group(card('river', 'The river runs.'));
  const apple = group(card('apple', 'An apple falls.'));
  const view = await readerHarness();
  try {
    await view.show({ groups: [river, river, river, apple], sentences: [s1, s2, s3, s4], initialGroupIndex: 2 });
    await playsHalfway(three);
    await act(() => view.controls().pause());
    assert.deepEqual(state(), { text: three, status: 'paused' });
    assert.deepEqual(view.paused, [true]);

    // Another device deletes the first sentence: App takes it out of the run, and the third moves up.
    await view.show({ groups: [river, river, apple], sentences: [s2, s3, s4], initialGroupIndex: 2 });
    assert.deepEqual(state(), { text: three, status: 'paused' }, 'the sentence isn\'t read again from its start');
    assert.deepEqual(view.paused, [true], 'auto-play stays paused');
    // Then the last one.
    await view.show({ groups: [river, river], sentences: [s2, s3], initialGroupIndex: 1 });
    assert.deepEqual(state(), { text: three, status: 'paused' });
    assert.deepEqual(view.paused, [true]);
    assert.equal(playerElement().currentTime, 2, 'the paused read keeps its place');
  } finally {
    await view.close();
  }
});

test('a word card\'s example being read goes on where it was when a word before it leaves the view', async () => {
  const [first, second, third] = await Promise.all([sentence(), sentence(), sentence()]);
  const [a, b, c] = [card('a', first), card('b', second), card('c', third)].map(group);
  const view = await readerHarness();
  try {
    await view.show({ groups: [a, b, c], initialGroupIndex: 2 });
    await playsHalfway(third);
    const nowPlaying = lockScreen.metadata;
    assert.ok(nowPlaying, 'the lock screen shows what\'s read');
    await view.show({ groups: [b, c], initialGroupIndex: 2 });
    assert.deepEqual(state(), { text: third, status: 'playing' }, 'the read isn\'t started over');
    assert.equal(playerElement().currentTime, 2);
    assert.deepEqual(view.paused, []);
    assert.equal(lockScreen.metadata, nowPlaying, 'and the lock screen still shows it');
  } finally {
    await view.close();
  }
});

test('when the card on screen itself leaves, the one that takes its place is read from its start, though auto-play was paused', async () => {
  const [first, second, third] = await Promise.all([sentence(), sentence(), sentence()]);
  const [a, b, c] = [card('a', first), card('b', second), card('c', third)].map(group);
  const view = await readerHarness();
  try {
    await view.show({ groups: [a, b, c], initialGroupIndex: 1 });
    await playsHalfway(second);
    await act(() => view.controls().pause());
    await view.show({ groups: [a, c], initialGroupIndex: 1 });
    assert.deepEqual(state(), { text: third, status: 'loading' });
    assert.deepEqual(view.paused, [true, false], 'a new card always plays');
  } finally {
    await view.close();
  }
});

test('a new copy of the card being read, as a Got it or a sync brings, leaves its read alone, as does a new list of the same cards', async () => {
  const [first, second] = await Promise.all([sentence(), sentence()]);
  const a = card('a', first);
  const b = card('b', second);
  const view = await readerHarness();
  try {
    await view.show({ groups: [group(a), group(b)], initialGroupIndex: 1 });
    await playsHalfway(second);
    // Got it on the card records a review, and the library's new copy of the card reaches the view.
    const reviewed: StoredItem = { ...b, srs: { ...b.srs, totalReviews: 1, nextReview: Date.now() + 86_400_000 } };
    await view.show({ groups: [group(a), group(reviewed)], initialGroupIndex: 1 });
    assert.deepEqual(state(), { text: second, status: 'playing' });
    assert.equal(playerElement().currentTime, 2);
    // An example opened over a word card is handed its one card in a new list on every render.
    await view.show({ groups: [group(a), group(reviewed)], initialGroupIndex: 1 });
    assert.deepEqual(state(), { text: second, status: 'playing' });
    assert.equal(playerElement().currentTime, 2);
  } finally {
    await view.close();
  }
});
