import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WORD_FLASH, flashWord, type WordFlashKind } from '../../views/detail/wordFlash.ts';
import { useSentenceGestures } from '../../views/detail/useSentenceGestures.ts';

// The flash a tap or click leaves on a sentence's word (views/detail/wordFlash.ts), and where sentence review's word
// gestures (views/detail/useSentenceGestures.ts) paint it: before they play from the word or look it up.

/** A word that records its animations, and the order of everything done to it in `log`. */
class FakeWord {
  readonly started: { keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean }[] = [];
  constructor(readonly log: string[] = []) {}
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { keyframes, options, cancelled: false };
    this.started.push(animation);
    this.log.push(`flash ${options.duration}`);
    return { cancel: () => { animation.cancelled = true; } };
  }
}

test('a flash starts from its kind\'s first frame and fades back to the word\'s own paint over its duration', () => {
  for (const [kind, duration] of [['play', 300], ['lookup', 450]] as [WordFlashKind, number][]) {
    const word = new FakeWord();
    flashWord(word, kind);
    assert.equal(word.started.length, 1);
    const [{ keyframes, options }] = word.started;
    assert.equal(keyframes, WORD_FLASH[kind].keyframes);
    assert.deepEqual(options, { duration, easing: 'ease-out' });
    assert.equal(keyframes.length, 1, 'only the start: the browser fades to the word\'s own style');
    assert.equal(keyframes[0].offset, 0);
  }
  // Play is a pulse of the background; look-up is stronger, with a 2 px ring, and paints nothing that moves.
  const [play] = WORD_FLASH.play.keyframes;
  const [lookup] = WORD_FLASH.lookup.keyframes;
  assert.deepEqual(Object.keys(play).sort(), ['backgroundColor', 'offset']);
  assert.deepEqual(Object.keys(lookup).sort(), ['backgroundColor', 'boxShadow', 'offset']);
  assert.notEqual(play.backgroundColor, lookup.backgroundColor);
  assert.match(String(lookup.boxShadow), /^0 0 0 2px /);
});

test('hitting the same word again restarts its flash; another word\'s flash runs on', () => {
  const ice = new FakeWord();
  const cold = new FakeWord();
  flashWord(ice, 'play');
  flashWord(cold, 'lookup');
  flashWord(ice, 'lookup');
  assert.deepEqual(ice.started.map(animation => animation.cancelled), [true, false]);
  assert.deepEqual(cold.started.map(animation => animation.cancelled), [false]);
});

test('a word without element.animate, or whose browser refuses the keyframes, keeps its paint and nothing throws', () => {
  assert.doesNotThrow(() => flashWord({}, 'play'));
  assert.doesNotThrow(() => flashWord(null, 'lookup'));
  const refusing = new FakeWord();
  let refuse = true;
  const animate = refusing.animate.bind(refusing);
  refusing.animate = (keyframes, options) => {
    if (refuse) throw new DOMException('Partial keyframes are not supported', 'NotSupportedError');
    return animate(keyframes, options);
  };
  assert.doesNotThrow(() => flashWord(refusing, 'lookup'));
  refuse = false;
  flashWord(refusing, 'play');
  assert.deepEqual(refusing.started.map(animation => animation.cancelled), [false]);
});

// The gestures run in a server render with stand-ins for the DOM they read: a sentence (its <p>) holding words.

/** Enough of an element for the gesture handlers: closest() for the word selector, and contains(). */
class FakeNode extends FakeWord {
  dataset: Record<string, string> = {};
  clicks = 0;
  constructor(readonly parent: FakeNode | null, log: string[], offset?: number) {
    super(log);
    if (offset !== undefined) this.dataset.wordOffset = String(offset);
  }
  closest(selector: string): FakeNode | null {
    if (selector !== '[data-word-offset]') throw new Error(`the fake element can't match ${selector}`);
    return 'wordOffset' in this.dataset ? this : this.parent?.closest(selector) ?? null;
  }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
  click() {
    this.clicks++;
    this.log.push('click');
  }
}

let selection = '';
const globals = globalThis as Record<string, unknown>;
const had = { window: 'window' in globals, Element: 'Element' in globals };
before(() => {
  globals.window = { getSelection: () => ({ toString: () => selection }) };
  globals.Element = FakeNode;
});
after(() => {
  if (!had.window) delete globals.window;
  if (!had.Element) delete globals.Element;
});

/**
 * Sentence review's word gestures on a phone or a laptop, with a sentence holding the word "gamut" at offset 12.
 * `lookUpSelection` stands for useSelectionLookup's: whether a Cmd/Ctrl-click found a selected phrase to look up.
 */
function sentence(isMobile: boolean, lookUpSelection: () => boolean = () => false) {
  const log: string[] = [];
  const hero = new FakeNode(null, log);
  const gamut = new FakeNode(hero, log, 12);
  const blank = new FakeNode(hero, log);
  let handlers: ReturnType<typeof useSentenceGestures> | undefined;
  const Probe = () => {
    handlers = useSentenceGestures({
      rootRef: { current: null }, heroScrollRef: { current: null }, isMobile, sentencePage: 'sentence',
      setSentencePage: () => {}, isSentenceAutoPlayingRef: { current: false }, setShowSentenceAutoPlayPanel: () => {},
      onClose: () => {}, currentGroupIndexRef: { current: 0 }, goToSentence: () => {}, handleRemember: () => {},
      toggleSentencePlayback: () => {}, playFromWordOffset: offset => { log.push(`play from ${offset}`); },
      lookUpSelection,
    });
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  const click = (target: FakeNode, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) => {
    const event = {
      target, currentTarget: hero, metaKey: false, ctrlKey: false, ...modifiers, stopped: false,
      preventDefault() {}, stopPropagation() { event.stopped = true; },
    };
    handlers!.handleSentenceWordClickCapture(event as never);
    return event.stopped;
  };
  const twoFingerTap = (target: FakeNode) => handlers!.handleMobileWordTouchStart(
    { touches: { length: 2 }, target, currentTarget: hero, stopPropagation() {} } as never,
  );
  return { log, gamut, blank, click, twoFingerTap };
}

test('on a laptop a click on a word flashes it, then plays from it; Cmd or Ctrl-click flashes it for its own look-up', () => {
  selection = '';
  const laptop = sentence(false);
  assert.equal(laptop.click(laptop.gamut), true, 'the word\'s look-up handler never sees a plain click');
  assert.deepEqual(laptop.log.splice(0), ['flash 300', 'play from 12']);
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.equal(laptop.click(laptop.gamut, modifier), false, 'the word\'s own handler looks it up');
    assert.deepEqual(laptop.log.splice(0), ['flash 450']);
  }
  // Blank space between words is no word: nothing flashes, and the click goes on to the page.
  assert.equal(laptop.click(laptop.blank, { metaKey: true }), false);
  assert.deepEqual(laptop.log, []);
});

test('with text still selected a click finishes the selection: no flash, no play, and the word looks nothing up', () => {
  selection = 'ran the gamut';
  try {
    const laptop = sentence(false);
    laptop.click(laptop.gamut);
    laptop.click(laptop.gamut, { metaKey: true });
    const phone = sentence(true);
    phone.twoFingerTap(phone.gamut);
    assert.deepEqual([...laptop.log, ...phone.log], ['click'], 'only the chord\'s own click, which the word swallows');
  } finally {
    selection = '';
  }
});

test('on a phone a tap on a word flashes it and plays from it; a two-finger tap flashes it before it looks it up', () => {
  selection = '';
  const phone = sentence(true);
  phone.click(phone.gamut);
  assert.deepEqual(phone.log.splice(0), ['flash 300', 'play from 12']);
  phone.twoFingerTap(phone.gamut);
  assert.deepEqual(phone.log.splice(0), ['flash 450', 'click']);
  assert.equal(phone.gamut.clicks, 1);
});

test('a Cmd or Ctrl-click inside a selected phrase is the phrase\'s: the word under it neither flashes nor looks itself up', () => {
  selection = '';
  let phraseFound = true;
  const asked: string[] = [];
  const laptop = sentence(false, () => { asked.push('phrase?'); return phraseFound; });
  assert.equal(laptop.click(laptop.gamut, { metaKey: true }), true, 'kept from the word\'s own look-up');
  assert.deepEqual(laptop.log.splice(0), []);
  // No phrase found: the word is looked up as before. A plain click never asks.
  phraseFound = false;
  assert.equal(laptop.click(laptop.gamut, { ctrlKey: true }), false);
  assert.deepEqual(laptop.log.splice(0), ['flash 450']);
  laptop.click(laptop.gamut);
  assert.deepEqual(laptop.log.splice(0), ['flash 300', 'play from 12']);
  assert.deepEqual(asked, ['phrase?', 'phrase?']);
});
