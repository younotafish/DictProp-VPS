import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SRSData, StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import {
  TAP_CONTROL_SELECTOR, acceptRemember, doubleTapControlSelector, isFlingStopTap, zoneDoubleTapUndo, zoneTapEffect,
} from '../../services/reviewGestures.ts';
import { useRememberToast } from '../../views/detail/useRememberToast.ts';
import { useSentenceActions } from '../../views/detail/useSentenceActions.ts';
import { useWordActions } from '../../views/detail/useWordActions.ts';

// services/reviewGestures.ts, the rules that keep review gestures from misfiring, and the card view's hooks that
// follow them.

/** Runs a hook once, in a server render, and hands back what it returned; refs and callbacks keep working after. */
function capture<T>(useHook: () => T): T {
  let result: T | undefined;
  const Probe = () => { result = useHook(); return null; };
  renderToStaticMarkup(createElement(Probe));
  return result as T;
}

test('a remember counts unless the same item counted less than 1.5 s before', () => {
  const last = { id: 'apple', at: 10_000 };
  assert.equal(acceptRemember(null, 'apple', 10_000), true, 'the first remember counts');
  assert.equal(acceptRemember(last, 'apple', 10_000), false, 'the dblclick a double-tap makes lands at once');
  assert.equal(acceptRemember(last, 'apple', 11_499), false);
  assert.equal(acceptRemember(last, 'apple', 11_500), true, 'from 1.5 s on, the same item counts again');
  assert.equal(acceptRemember(last, 'pear', 10_001), true, 'another item always counts');
  assert.equal(acceptRemember(last, 'apple', 10_400, 300), true, 'the window can be given');
});

const vocabItem = (id: string, word: string): StoredItem => ({
  type: 'vocab',
  data: {
    id, word, sense: '', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '',
  },
  savedAt: 0,
  srs: SRSAlgorithm.createNew(id, 'vocab', 0),
});

const sentenceItem = (id: string): StoredItem => ({
  type: 'sentence',
  data: { id, text: `Sentence ${id}.`, sourceWord: id },
  savedAt: 0,
  srs: SRSAlgorithm.createNew(id, 'sentence', 0),
});

test('in sentence review R, ↓, R reviews both sentences at once, and one gesture reviews a sentence once', () => {
  const { tryRemember } = capture(() => useRememberToast());
  const reviewed: string[] = [];
  const confirmed: string[] = [];
  const onScreen = { current: sentenceItem('A') as StoredItem | null };
  const { handleRemember } = capture(() => useSentenceActions({
    currentSentence: onScreen.current, currentSentenceRef: onScreen, isSentencePreview: false,
    catalogSentencePreview: false, onSave: () => {}, onDelete: () => {},
    onUpdateSRS: id => { reviewed.push(id); }, tryRemember,
    showRemembered: (_next: SRSData, _now: number, id: string) => { confirmed.push(id); },
  }));

  handleRemember();
  handleRemember(); // the dblclick the browser makes of a touch double-tap
  onScreen.current = sentenceItem('B');
  handleRemember();
  assert.deepEqual(reviewed, ['A', 'B']);
  assert.deepEqual(confirmed, ['A', 'B'], 'each confirmation names the sentence it confirms');
});

test('on a word card Got it on the next card counts at once, and the confirmation names the card on screen', () => {
  const { tryRemember } = capture(() => useRememberToast());
  const reviewed: string[] = [];
  const confirmed: string[] = [];
  const library = [vocabItem('apple-1', 'apple'), vocabItem('pear-1', 'pear')];
  const actionsFor = (card: StoredItem) => capture(() => useWordActions({
    data: card.data, type: card.type, title: (card.data as VocabCard).word, savedItemMatch: card, isSaved: true,
    savedItemsRef: { current: library }, isVocabSaved: () => true, onSave: () => {}, onDelete: () => {},
    onUpdateSRS: id => { reviewed.push(id); }, setShowActionMenu: () => {}, tryRemember,
    showRemembered: (_next: SRSData, _now: number, id: string) => { confirmed.push(id); },
  }));

  const apple = actionsFor(library[0]);
  apple.handleRemember();
  apple.handleRemember();
  actionsFor(library[1]).handleRemember();
  assert.deepEqual(reviewed, ['apple-1', 'pear-1']);
  assert.deepEqual(confirmed, ['apple-1', 'pear-1']);
});

/** The simple selectors a selector list names, in no particular order. */
const parts = (selector: string) => new Set(selector.split(',').map(part => part.trim()));

test('a double tap never counts on a native control; on a word card the ARIA-button look-up words are controls too', () => {
  for (const mode of ['card', 'sentence'] as const) {
    for (const control of ['button', 'a', 'input', 'textarea', 'select', 'label', '[contenteditable="true"]']) {
      assert.ok(parts(doubleTapControlSelector(mode)).has(control), `${control} is a control in ${mode} mode`);
    }
  }
  assert.ok(parts(doubleTapControlSelector('card')).has('[role="button"]'));
  assert.ok(!parts(doubleTapControlSelector('sentence')).has('[role="button"]'), 'a double tap on a sentence word still remembers');
  assert.equal(doubleTapControlSelector('sentence'), TAP_CONTROL_SELECTOR);
});

test('a word card\'s taps leave alone the controls they always did', () => {
  const before = 'button, a, [role="button"], input, textarea, select, label, [contenteditable="true"]';
  assert.deepEqual(parts(doubleTapControlSelector('card')), parts(before));
});

const SENTENCE = 'She finally came clean.';
const OTHER = 'You should come clean before they find out.';
const state = (status: 'idle' | 'loading' | 'playing' | 'paused', text: string | null = status === 'idle' ? null : SENTENCE) => ({ text, status });

test('a read-band tap started, paused or resumed its sentence, read from the engine before and after it', () => {
  assert.equal(zoneTapEffect(state('idle'), state('loading')), 'started');
  assert.equal(zoneTapEffect(state('playing', OTHER), state('loading')), 'started', 'another sentence was playing');
  assert.equal(zoneTapEffect(state('loading', OTHER), state('loading')), 'started', 'another sentence was loading');
  assert.equal(zoneTapEffect(state('playing'), state('loading')), 'started', 'near its end, the sentence starts again');
  assert.equal(zoneTapEffect(state('playing'), state('paused')), 'paused');
  assert.equal(zoneTapEffect(state('paused'), state('playing')), 'resumed');
  assert.equal(zoneTapEffect(state('loading'), state('loading')), null, 'a tap leaves a sentence that is still loading alone');
  assert.equal(zoneTapEffect(state('playing'), state('playing')), null);
  assert.equal(zoneTapEffect(state('idle'), state('idle')), null);
  assert.equal(zoneTapEffect(state('paused', OTHER), state('playing')), null, 'not the same sentence');
});

test('the second tap of a double tap in the read bands undoes the first, so playback ends as it was', () => {
  const first = (before: 'started' | 'paused' | 'resumed') => ({ at: 1_000, x: 120, y: 90, before });
  assert.equal(zoneDoubleTapUndo(first('started'), 1_200, 125, 95), 'stop');
  assert.equal(zoneDoubleTapUndo(first('paused'), 1_200, 125, 95), 'resume');
  assert.equal(zoneDoubleTapUndo(first('resumed'), 1_200, 125, 95), 'pause');
  assert.equal(zoneDoubleTapUndo(null, 1_200, 125, 95), null, 'no first tap changed playback');
});

test('a double tap is two taps within 450 ms and 40 px of each other', () => {
  const first = { at: 1_000, x: 120, y: 90, before: 'started' as const };
  assert.equal(zoneDoubleTapUndo(first, 1_450, 120, 90), 'stop');
  assert.equal(zoneDoubleTapUndo(first, 1_451, 120, 90), null);
  assert.equal(zoneDoubleTapUndo(first, 1_100, 160, 50), 'stop');
  assert.equal(zoneDoubleTapUndo(first, 1_100, 161, 90), null);
  assert.equal(zoneDoubleTapUndo(first, 1_100, 120, 49), null);
});

test('a touch that lands within 120 ms of the page\'s last scroll stops a fling, so its tap does nothing else', () => {
  assert.equal(isFlingStopTap(5_000, 5_080), true, 'the page scrolled 80 ms before the finger landed');
  assert.equal(isFlingStopTap(5_000, 5_119), true);
  assert.equal(isFlingStopTap(5_000, 5_120), false);
  assert.equal(isFlingStopTap(5_000, 5_200), false, 'a page at rest for 200 ms takes taps');
  assert.equal(isFlingStopTap(-Infinity, 5_000), false, 'nothing has scrolled yet');
  assert.equal(isFlingStopTap(5_000, 5_150, 200), true, 'the window can be given');
});
