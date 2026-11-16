import assert from 'node:assert/strict';
import test from 'node:test';
import { sentenceTouchAction, touchFacts, wordTouchAction, type ScrollPosition } from '../../views/detail/touchGestures.ts';
import { TAP_CONTROL_SELECTOR, doubleTapControlSelector } from '../../services/reviewGestures.ts';

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
  // The sentence page has no measured scroller (detail-view-09), so it counts as at both ends.
  assert.equal(sentence(0, -121, null), 'next');
  assert.equal(sentence(0, 121, null), 'previous');
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
