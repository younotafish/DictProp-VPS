import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ItemGroup, StoredItem } from '../../types.ts';
import {
  scrollEdges, sentenceTouchAction, touchFacts, wordTouchAction, type ScrollPosition,
} from '../../views/detail/touchGestures.ts';
import { TAP_CONTROL_SELECTOR, doubleTapControlSelector } from '../../services/reviewGestures.ts';
import { useSentenceGestures } from '../../views/detail/useSentenceGestures.ts';
import { useWordGestures } from '../../views/detail/useWordGestures.ts';

const top: ScrollPosition = { scrollTop: 0, scrollHeight: 2000, clientHeight: 800 };
const middle: ScrollPosition = { scrollTop: 600, scrollHeight: 2000, clientHeight: 800 };
const bottom: ScrollPosition = { scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 };
const short: ScrollPosition = { scrollTop: 0, scrollHeight: 500, clientHeight: 800 };

test('a finger that moves ten pixels or less is a still tap', () => {
  assert.equal(touchFacts(10, -10, top).isStillTap, true);
  assert.equal(touchFacts(11, 0, top).isStillTap, false);
  assert.equal(touchFacts(0, 11, top).isStillTap, false);
});

test('vertical swipes need 50 px and a mostly vertical path; short ones end before 120 px, long ones start there', () => {
  assert.equal(touchFacts(0, 50, top).isVerticalSwipe, false);
  assert.equal(touchFacts(0, 51, top).isVerticalSwipe, true);
  assert.equal(touchFacts(40, 60, top).isVerticalSwipe, false, 'not 1.5 times taller than wide');
  assert.equal(touchFacts(0, 119, top).isShortSwipe, true);
  assert.equal(touchFacts(0, 119, top).isLongSwipe, false);
  assert.equal(touchFacts(0, -120, top).isShortSwipe, false);
  assert.equal(touchFacts(0, -120, top).isLongSwipe, true);
});

test('horizontal swipes need 60 px and a mostly horizontal path', () => {
  assert.equal(touchFacts(60, 0, top).isHorizontalSwipe, false);
  assert.equal(touchFacts(-61, 0, top).isHorizontalSwipe, true);
  assert.equal(touchFacts(90, 61, top).isHorizontalSwipe, false);
});

test('edges come from the scroller, with five pixels of slack, and a missing scroller is at both ends', () => {
  assert.deepEqual(pick(touchFacts(0, 0, { scrollTop: 5, scrollHeight: 2000, clientHeight: 800 })), { atTop: true, atBottom: false, fits: false });
  assert.deepEqual(pick(touchFacts(0, 0, { scrollTop: 1195, scrollHeight: 2000, clientHeight: 800 })), { atTop: false, atBottom: true, fits: false });
  assert.deepEqual(pick(touchFacts(0, 0, short)), { atTop: true, atBottom: true, fits: true });
  assert.deepEqual(pick(touchFacts(0, 0, null)), { atTop: true, atBottom: true, fits: true });
});

const sentence = (dx: number, dy: number, scroller: ScrollPosition | null, options: Partial<Parameters<typeof sentenceTouchAction>[1]> = {}) =>
  sentenceTouchAction(touchFacts(dx, dy, scroller), {
    onAnalysisPage: false, autoPlaying: false, onControl: false, onSentenceWord: false, ...options,
  });

test('in sentence review a sideways swipe flips pages, and right off the sentence page leaves unless auto-play is on', () => {
  assert.equal(sentence(-80, 0, null), 'show-analysis');
  assert.equal(sentence(80, 0, null, { onAnalysisPage: true }), 'show-sentence');
  assert.equal(sentence(-80, 0, null, { onAnalysisPage: true }), 'show-sentence');
  assert.equal(sentence(80, 0, null), 'close');
  assert.equal(sentence(80, 0, null, { autoPlaying: true }), 'open-auto-play-panel');
});

test('in sentence review a still tap on blank space is a surface tap, but not on a control or a word', () => {
  assert.equal(sentence(3, -2, null), 'surface-tap');
  assert.equal(sentence(3, -2, middle, { onAnalysisPage: true }), 'surface-tap');
  assert.equal(sentence(3, -2, null, { onControl: true }), null);
  assert.equal(sentence(3, -2, null, { onSentenceWord: true }), null);
});

test('in sentence review a long swipe changes sentences only at the matching end of the page', () => {
  assert.equal(sentence(0, -121, bottom, { onAnalysisPage: true }), 'next');
  assert.equal(sentence(0, -121, short, { onAnalysisPage: true }), 'next', 'content shorter than the page');
  assert.equal(sentence(0, -121, middle, { onAnalysisPage: true }), null);
  assert.equal(sentence(0, 121, top, { onAnalysisPage: true }), 'previous');
  assert.equal(sentence(0, 121, middle, { onAnalysisPage: true }), null);
  assert.equal(sentence(0, -120, bottom), null, 'exactly 120 px is long but not past the threshold');
  assert.equal(sentence(0, 100, top), null, 'short swipes do nothing in sentence review');
  // The sentence page measures its own scroller too: a long sentence with a picture scrolls before it changes.
  assert.equal(sentence(0, -121, middle), null);
  assert.equal(sentence(0, -121, bottom), 'next');
  assert.equal(sentence(0, -121, short), 'next', 'a sentence that fits the page');
  assert.equal(sentence(0, 121, middle), null);
  assert.equal(sentence(0, 121, top), 'previous');
});

const word = (dx: number, dy: number, scroller: ScrollPosition | null, options: Partial<Parameters<typeof wordTouchAction>[1]> = {}) =>
  wordTouchAction(touchFacts(dx, dy, scroller), {
    onControl: false, y: 100, viewportHeight: 800, hasNextGroup: true, hasPrevGroup: true, hasPrevItem: true, ...options,
  });

test('on a word card a still tap reads by screen band: top quarter, second quarter, nothing below', () => {
  assert.deepEqual(word(0, 0, top, { y: 199 }), { kind: 'read-zone', zone: 0 });
  assert.deepEqual(word(0, 0, top, { y: 200 }), { kind: 'read-zone', zone: 1 });
  assert.deepEqual(word(0, 0, top, { y: 399 }), { kind: 'read-zone', zone: 1 });
  assert.equal(word(0, 0, top, { y: 400 }), null);
  assert.equal(word(0, 0, top, { y: 10, onControl: true }), null);
});

test('on a word card a short swipe down at the top reveals the header, and other short swipes do nothing', () => {
  assert.deepEqual(word(0, 80, top), { kind: 'reveal-header' });
  assert.equal(word(0, 80, middle), null);
  assert.equal(word(0, -80, bottom), null);
});

test('on a word card a long swipe changes words at the matching end, when there is one', () => {
  assert.deepEqual(word(0, -150, bottom), { kind: 'next-word' });
  assert.deepEqual(word(0, -150, short), { kind: 'next-word' });
  assert.equal(word(0, -150, middle), null);
  assert.equal(word(0, -150, bottom, { hasNextGroup: false }), null);
  assert.deepEqual(word(0, 150, top), { kind: 'previous-word' });
  assert.equal(word(0, 150, top, { hasPrevGroup: false }), null);
  assert.equal(word(0, 150, middle), null);
});

test('on a word card a sideways swipe changes the meaning, and right past the first meaning leaves', () => {
  assert.deepEqual(word(-70, 5, top), { kind: 'next-meaning' });
  assert.deepEqual(word(70, 5, top), { kind: 'previous-meaning' });
  assert.deepEqual(word(70, 5, top, { hasPrevItem: false }), { kind: 'close' });
  assert.equal(word(55, 0, top), null);
});

function pick({ atTop, atBottom, fits }: ReturnType<typeof touchFacts>) {
  return { atTop, atBottom, fits };
}

test('the edges a touch goes by are where its scroller stood when it began, when the view measured that', () => {
  assert.deepEqual(scrollEdges(middle), { atTop: false, atBottom: false, fits: false });
  assert.deepEqual(scrollEdges(null), { atTop: true, atBottom: true, fits: true });
  // The drag scrolled from the middle to the bottom: the facts keep the middle.
  assert.deepEqual(pick(touchFacts(0, -150, bottom, scrollEdges(middle))), { atTop: false, atBottom: false, fits: false });
  assert.deepEqual(pick(touchFacts(0, -150, bottom)), { atTop: false, atBottom: true, fits: false }, 'without a snapshot, the end');
});

/** A swipe of `dy` that began with its scroller at `startedAt` and ended at `endedAt`. */
const wordSwipe = (dy: number, startedAt: ScrollPosition, endedAt: ScrollPosition) =>
  wordTouchAction(touchFacts(0, dy, endedAt, scrollEdges(startedAt)), {
    onControl: false, y: 100, viewportHeight: 800, hasNextGroup: true, hasPrevGroup: true, hasPrevItem: true,
  });
const sentenceSwipe = (dy: number, startedAt: ScrollPosition, endedAt: ScrollPosition, onAnalysisPage = false) =>
  sentenceTouchAction(touchFacts(0, dy, endedAt, scrollEdges(startedAt)), {
    onAnalysisPage, autoPlaying: false, onControl: false, onSentenceWord: false,
  });

test('a long swipe changes words only when it starts at the matching edge; one that reaches it partway only scrolls', () => {
  assert.equal(wordSwipe(-150, middle, bottom), null, 'started mid-card, reached the bottom');
  assert.equal(wordSwipe(150, middle, top), null, 'scrolled down a little, dragged back up to the picture');
  assert.deepEqual(wordSwipe(-150, bottom, bottom), { kind: 'next-word' });
  assert.deepEqual(wordSwipe(150, top, top), { kind: 'previous-word' });
  assert.deepEqual(wordSwipe(-150, short, short), { kind: 'next-word' }, 'a card that fits the page');
  // The pull-down that opens the header starts at the top too.
  assert.equal(wordSwipe(80, middle, top), null);
  assert.deepEqual(wordSwipe(80, top, top), { kind: 'reveal-header' });
});

test('in sentence review a long swipe changes sentences only when it starts at the page\'s matching end', () => {
  for (const onAnalysisPage of [false, true]) {
    assert.equal(sentenceSwipe(-150, middle, bottom, onAnalysisPage), null);
    assert.equal(sentenceSwipe(150, middle, top, onAnalysisPage), null);
    assert.equal(sentenceSwipe(-150, bottom, bottom, onAnalysisPage), 'next');
    assert.equal(sentenceSwipe(150, top, top, onAnalysisPage), 'previous');
  }
});

/** A stand-in for a DOM element: enough of closest() for the selectors the gesture guards use. */
class FakeElement {
  constructor(readonly tag: string, readonly attributes: Record<string, string> = {}, readonly parent: FakeElement | null = null) {}

  closest(selector: string): FakeElement | null {
    const matches = selector.split(',').some(simple => this.matchesSimple(simple.trim()));
    return matches ? this : this.parent?.closest(selector) ?? null;
  }

  private matchesSimple(simple: string): boolean {
    if (/^[a-z]+$/.test(simple)) return this.tag === simple;
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(simple);
    if (!attribute) throw new Error(`the fake element can't match ${simple}`);
    const [, name, value] = attribute;
    return value === undefined ? name in this.attributes : this.attributes[name] === value;
  }
}

/** Whether a double tap on `target` may count as Got it in that view. */
const remembers = (target: FakeElement, mode: 'card' | 'sentence') => !target.closest(doubleTapControlSelector(mode));

test('a double tap on a word card\'s controls, its look-up words included, never remembers; on blank space it does', () => {
  const scroller = new FakeElement('div', { 'data-word-card-scroll': '' });
  const definition = new FakeElement('p', {}, scroller);
  const example = new FakeElement('span', { class: 'sentence-selectable' }, definition);
  const controls = {
    trash: new FakeElement('button', { title: 'Delete (D)' }, scroller),
    speakerIcon: new FakeElement('svg', {}, new FakeElement('button', { 'aria-label': 'Listen to this sentence' }, scroller)),
    ipaChip: new FakeElement('button', {}, definition),
    termSearch: new FakeElement('span', {}, new FakeElement('button', { title: 'Search' }, definition)),
    link: new FakeElement('a', { href: 'https://example.com' }, definition),
    greenLookUpWord: new FakeElement('span', { role: 'button', tabindex: '0' }, example),
  };
  for (const [name, target] of Object.entries(controls)) assert.equal(remembers(target, 'card'), false, name);
  assert.equal(remembers(definition, 'card'), true);
  assert.equal(remembers(example, 'card'), true, 'plain sentence text is blank space');
  // A single tap leaves the same targets alone: the read bands never read under a control or a look-up word.
  for (const target of Object.values(controls)) assert.ok(target.closest(doubleTapControlSelector('card')));
});

test('in sentence review a double tap on a control never remembers, while one on the sentence\'s words still does', () => {
  const banner = new FakeElement('div');
  const hero = new FakeElement('p', { 'data-sentence-hero': '' }, banner);
  const sentence = new FakeElement('span', { class: 'sentence-selectable' }, hero);
  const savedWord = new FakeElement('span', { role: 'button', tabindex: '0', 'data-word-offset': '4' }, sentence);
  const lookUpWord = new FakeElement('span', { 'data-word-offset': '10' }, sentence);
  for (const word of [savedWord, lookUpWord]) {
    assert.equal(remembers(word, 'sentence'), true, 'double-tapping a word still remembers');
    assert.ok(word.closest(`${TAP_CONTROL_SELECTOR}, [data-word-offset]`), 'a single tap on a word plays from it instead');
  }
  const copyIcon = new FakeElement('svg', {}, new FakeElement('button', { title: 'Copy sentence (to paste into Meta AI)' }, banner));
  const reset = new FakeElement('button', { title: 'Reset memory (Shift+R)' }, banner);
  const imageNote = new FakeElement('div', { contenteditable: 'true' }, banner);
  for (const control of [copyIcon, reset, imageNote]) assert.equal(remembers(control, 'sentence'), false);
  assert.equal(remembers(banner, 'sentence'), true, 'blank space remembers');
});

/** Runs a hook once, in a server render, and hands back what it returned; refs and callbacks keep working after. */
function capture<T>(useHook: () => T): T {
  let result: T | undefined;
  const Probe = () => { result = useHook(); return null; };
  renderToStaticMarkup(createElement(Probe));
  return result as T;
}

/**
 * Sentence review's touch handlers, as the view wires them, on the sentence page of sentence 5 of a run. `hero` stands
 * for the sentence page's scroller; the handlers record what they asked the view to do.
 */
function sentencePage(hero: ScrollPosition) {
  const asked: string[] = [];
  const scroller = { ...hero };
  const handlers = capture(() => useSentenceGestures({
    rootRef: { current: null }, heroScrollRef: { current: scroller as unknown as HTMLElement }, isMobile: true,
    sentencePage: 'sentence', setSentencePage: page => { asked.push(`page ${String(page)}`); },
    isSentenceAutoPlayingRef: { current: false }, setShowSentenceAutoPlayPanel: () => {}, onClose: () => { asked.push('close'); },
    currentGroupIndexRef: { current: 5 }, goToSentence: index => { asked.push(`sentence ${index}`); },
    handleRemember: () => {}, toggleSentencePlayback: () => {}, playFromWordOffset: () => {}, lookUpSelection: () => false,
  }));
  /** A one-finger drag of `dy` px, the scroller standing at `during` once the finger has moved, if given. */
  const swipe = (dy: number, during?: ScrollPosition) => {
    const globals = globalThis as Record<string, unknown>;
    globals.window = { getSelection: () => null };
    try {
      handlers.onContentTouchStart({ touches: [{ clientX: 200, clientY: 400 }], timeStamp: 1_000 } as never);
      if (during) Object.assign(scroller, during);
      handlers.onContentTouchEnd({ changedTouches: [{ clientX: 200, clientY: 400 + dy }], target: null, timeStamp: 1_300 } as never);
    } finally {
      delete globals.window;
    }
    return asked.splice(0);
  };
  return { swipe };
}

test('on the sentence page a long swipe scrolls a long sentence to its end before it changes sentences', () => {
  assert.deepEqual(sentencePage(middle).swipe(-150), [], 'mid-sentence: the drag only scrolls');
  assert.deepEqual(sentencePage(bottom).swipe(-150), ['sentence 6']);
  assert.deepEqual(sentencePage(short).swipe(-150), ['sentence 6'], 'a sentence that fits the page');
  assert.deepEqual(sentencePage(middle).swipe(150), []);
  assert.deepEqual(sentencePage(top).swipe(150), ['sentence 4']);
  // A drag that starts mid-sentence and reaches an end on the way only scrolls.
  assert.deepEqual(sentencePage(middle).swipe(-150, bottom), []);
  assert.deepEqual(sentencePage(middle).swipe(150, top), []);
});

/** The word card's touch handlers, as the view wires them, on word 5 of 10; `page` stands for the card's scroller. */
function wordCard(page: ScrollPosition) {
  const asked: string[] = [];
  const scroller = { ...page };
  const card = { type: 'vocab', data: { id: 'w5', word: 'gamut', examples: [] }, savedAt: 1 } as unknown as StoredItem;
  const handlers = capture(() => useWordGestures({
    scrollContainerRef: { current: scroller as unknown as HTMLElement }, showHeader: false,
    setShowHeader: shown => { asked.push(`header ${String(shown)}`); }, currentGroup: { title: 'gamut', items: [card] } as ItemGroup,
    currentItem: card, hasNextGroup: true, hasPrevGroup: true, hasPrevItem: false,
    setCurrentGroupIndex: next => { asked.push(`word ${typeof next === 'function' ? next(5) : next}`); },
    setCurrentItemIndex: () => {}, stopSlideshow: () => {}, toggleSpeak: () => {}, onClose: () => { asked.push('close'); },
    handleRemember: () => {},
  }));
  const swipe = (dy: number, during?: ScrollPosition) => {
    const globals = globalThis as Record<string, unknown>;
    globals.window = { getSelection: () => null, innerHeight: 800 };
    try {
      handlers.onContentTouchStart({ touches: [{ clientX: 200, clientY: 500 }], timeStamp: 1_000 } as never);
      if (during) Object.assign(scroller, during);
      handlers.onContentTouchEnd({ changedTouches: [{ clientX: 200, clientY: 500 + dy }], target: null, timeStamp: 1_300 } as never);
    } finally {
      delete globals.window;
    }
    return asked.splice(0).filter(step => step !== 'header false');
  };
  return { swipe };
}

test('on a word card the edges are measured as the touch begins, so reaching the top on the way never changes the word', () => {
  assert.deepEqual(wordCard(middle).swipe(150, top), [], 'scrolled down a little, dragged back up to the picture');
  assert.deepEqual(wordCard(middle).swipe(-150, bottom), []);
  assert.deepEqual(wordCard(top).swipe(150), ['word 4']);
  assert.deepEqual(wordCard(bottom).swipe(-150), ['word 6']);
  assert.deepEqual(wordCard(middle).swipe(80, top), [], 'nor does it open the header');
  assert.deepEqual(wordCard(top).swipe(80), ['header true']);
});
