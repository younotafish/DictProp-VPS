import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleSentenceKey, handleWordKey, type CardKeyEvent, type SentenceKeyHandlers, type WordKeyHandlers,
} from '../../views/detail/cardKeys.ts';
import { handleNavKey, type NavKeyEvent } from '../../hooks/useKeyboardNavigation.ts';
import type { StoredItem } from '../../types.ts';

// The card view's keys: views/detail/cardKeys.ts, its letter shortcuts, and useKeyboardNavigation's arrows and Enter.

type Modifiers = Partial<Pick<CardKeyEvent, 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'repeat'>>;

/** A key press that records whether a shortcut kept it from the browser. */
const press = (key: string, modifiers: Modifiers = {}) => {
  const event = {
    key, repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers,
    prevented: false,
    preventDefault() { event.prevented = true; },
  };
  return event;
};

// The handlers of one card on screen. Each records what it did in `done`, naming the card it belongs to. The
// title stays empty, so P never reaches the speech engine.
const sentenceOnScreen = (sentence: string, done: string[], flags: Partial<SentenceKeyHandlers> = {}): SentenceKeyHandlers => ({
  title: '',
  speakSentenceAt: index => done.push(`read example ${index + 1} of ${sentence}`),
  readCurrentSentence: () => done.push(`read ${sentence}`),
  isSentencePreview: false,
  catalogSentencePreview: false,
  handleRemember: () => done.push(`remember ${sentence}`),
  handleResetSRS: () => done.push(`reset ${sentence}`),
  handleDeleteItem: () => done.push(`delete ${sentence}`),
  onSpace: () => done.push(`space on ${sentence}`),
  ...flags,
});

const wordOnScreen = (word: string, done: string[], flags: Partial<WordKeyHandlers> = {}): WordKeyHandlers => ({
  speakSentenceAt: index => done.push(`read example ${index + 1} of ${word}`),
  setShowHeader: update => done.push(`header ${typeof update === 'function' ? update(false) : update}`),
  title: '',
  readCardExamples: () => done.push(`read ${word}`),
  handleRemember: () => done.push(`remember ${word}`),
  handleResetSRS: () => done.push(`reset ${word}`),
  handleSaveShortcut: () => done.push(`save ${word}`),
  handleDeleteItem: () => done.push(`delete ${word}`),
  handleArchiveItem: () => done.push(`archive ${word}`),
  isSaved: false,
  savedItemMatch: undefined,
  handleUnarchiveItem: () => done.push(`unarchive ${word}`),
  onSpace: () => done.push(`space on ${word}`),
  cycleSpeed: () => done.push('cycle speed'),
  ...flags,
});

test('after a move from sentence A to sentence B of the same word, D deletes B, the sentence on screen', () => {
  const done: string[] = [];
  // What useSentenceShortcuts' listener reads as each key is pressed; useLatest keeps it on the sentence on screen.
  const onScreen = { current: sentenceOnScreen('A', done) };
  const listener = (e: CardKeyEvent) => handleSentenceKey(e, onScreen.current);

  listener(press('e'));
  // ↓ to B. The listener added for A stays, and reads B's handlers as the next keys are pressed.
  onScreen.current = sentenceOnScreen('B', done);
  listener(press('d'));
  listener(press('R', { shiftKey: true }));
  assert.deepEqual(done, ['read A', 'delete B', 'reset B']);
});

test('a sentence preview deletes nothing on D; R and Shift+R stay the browser\'s unless R can remember a catalog line', () => {
  const done: string[] = [];
  const preview = sentenceOnScreen('preview', done, { isSentencePreview: true });
  const catalogLine = sentenceOnScreen('catalog line', done, { isSentencePreview: true, catalogSentencePreview: true });

  const deletePreview = press('d');
  handleSentenceKey(deletePreview, preview);
  assert.equal(deletePreview.prevented, true, 'D is still the view\'s key');
  for (const key of [press('r'), press('R', { shiftKey: true })]) {
    handleSentenceKey(key, preview);
    assert.equal(key.prevented, false, key.key);
  }

  const remember = press('r');
  handleSentenceKey(remember, catalogLine);
  const reset = press('R', { shiftKey: true });
  handleSentenceKey(reset, catalogLine);
  assert.deepEqual([remember.prevented, reset.prevented], [true, false]);
  assert.deepEqual(done, ['remember catalog line']);
});

test('D deletes nothing in a catalog lesson, whether or not its line has a record yet, and stays the view\'s key', () => {
  const done: string[] = [];
  const reviewedLine = sentenceOnScreen('reviewed line', done, { catalogSentencePreview: true });
  const newLine = sentenceOnScreen('new line', done, { isSentencePreview: true, catalogSentencePreview: true });
  for (const handlers of [reviewedLine, newLine]) {
    const key = press('d');
    handleSentenceKey(key, handlers);
    assert.equal(key.prevented, true);
  }
  handleSentenceKey(press('R', { shiftKey: true }), reviewedLine);
  assert.deepEqual(done, ['reset reviewed line'], 'a reviewed line can still be reset');
});

test('Cmd or Ctrl with 1 to 4 reads that example of the source card; other modified keys are left alone', () => {
  const done: string[] = [];
  const handlers = sentenceOnScreen('A', done);
  const keys = [
    press('2', { metaKey: true }), press('4', { ctrlKey: true }),
    press('5', { metaKey: true }), press('r', { metaKey: true }), press('d', { ctrlKey: true }), press('e', { altKey: true }),
  ];
  for (const key of keys) handleSentenceKey(key, handlers);
  assert.deepEqual(keys.map(key => key.prevented), [true, true, false, false, false, false]);
  assert.deepEqual(done, ['read example 2 of A', 'read example 4 of A']);
});

test('sentence review has no slide speed, so + and = are left to the browser', () => {
  const done: string[] = [];
  const keys = [press('+'), press('=')];
  for (const key of keys) handleSentenceKey(key, sentenceOnScreen('A', done));
  assert.deepEqual(keys.map(key => key.prevented), [false, false]);
  assert.deepEqual(done, []);
});

test('Space goes once to the view\'s own Space, which decides what it does; with Cmd, Ctrl or Alt it stays the browser\'s', () => {
  // What Space does (auto-play's pause, the play rule, auto-play or the slideshow) is decided by the views'
  // handleSpace, from services/audio/playbackToggle.ts (test/client/playback-toggle.test.ts).
  const done: string[] = [];
  const tables = [
    (key: CardKeyEvent) => handleSentenceKey(key, sentenceOnScreen('A', done)),
    (key: CardKeyEvent) => handleWordKey(key, wordOnScreen('apple', done)),
  ];
  for (const table of tables) {
    const keys = [press(' '), press(' ', { shiftKey: true }), press(' ', { metaKey: true }), press(' ', { ctrlKey: true }), press(' ', { altKey: true })];
    keys.forEach(table);
    assert.deepEqual(keys.map(key => key.prevented), [true, true, false, false, false]);
  }
  assert.deepEqual(done, ['space on A', 'space on A', 'space on apple', 'space on apple']);
});

test('the word card\'s D and A act on the card on screen, only once it is saved, and A unarchives an archived card', () => {
  const done: string[] = [];
  const onScreen = { current: wordOnScreen('apple', done, { isSaved: true }) };
  const listener = (e: CardKeyEvent) => handleWordKey(e, onScreen.current);

  listener(press('a'));
  onScreen.current = wordOnScreen('pear', done, { isSaved: true });
  listener(press('d'));

  onScreen.current = wordOnScreen('plum', done);
  const unsavedKeys = [press('d'), press('a')];
  unsavedKeys.forEach(listener);
  assert.deepEqual(unsavedKeys.map(key => key.prevented), [true, true], 'D and A are still the view\'s keys');

  const archivedFig = { type: 'vocab', savedAt: 0, isArchived: true, data: { id: 'fig-1', word: 'fig' } } as unknown as StoredItem;
  onScreen.current = wordOnScreen('fig', done, { isSaved: true, savedItemMatch: archivedFig });
  listener(press('A', { shiftKey: true }));
  assert.deepEqual(done, ['archive apple', 'delete pear', 'unarchive fig']);
});

test('the word card\'s H, R, S, E, Space and + keys', () => {
  const done: string[] = [];
  const handlers = wordOnScreen('apple', done);
  for (const key of [press('h'), press('r'), press('R', { shiftKey: true }), press('s'), press('e'), press(' '), press('+'), press('=')]) {
    handleWordKey(key, handlers);
  }
  assert.deepEqual(done, [
    'header true', 'remember apple', 'reset apple', 'save apple', 'read apple', 'space on apple',
    'cycle speed', 'cycle speed',
  ]);
});

test('B does nothing in the sentence lesson or on a word card: both leave it to the browser, with or without Shift', () => {
  // The practice pill B pressed is gone: a Today unit's sentences are remembered with Got it, as on the Sentences tab.
  const done: string[] = [];
  const tables = [
    sentenceOnScreen('A', done),
    sentenceOnScreen('preview', done, { isSentencePreview: true }),
    sentenceOnScreen('catalog line', done, { catalogSentencePreview: true }),
  ].map(handlers => (key: CardKeyEvent) => handleSentenceKey(key, handlers)).concat(
    [true, false].map(isSaved => (key: CardKeyEvent) => handleWordKey(key, wordOnScreen('apple', done, { isSaved }))),
  );
  for (const table of tables) {
    // Shift, or Caps Lock, types a capital B.
    const keys = [press('b'), press('B', { shiftKey: true }), press('B')];
    keys.forEach(table);
    assert.deepEqual(keys.map(key => key.prevented), [false, false, false]);
  }
  assert.deepEqual(done, []);
});

test('S saves the card as Cmd/Ctrl+S does, on a saved card too, where saving does nothing: it never deletes', () => {
  const done: string[] = [];
  for (const isSaved of [false, true]) {
    const key = press('s');
    handleWordKey(key, wordOnScreen('apple', done, { isSaved }));
    assert.equal(key.prevented, true);
  }
  assert.deepEqual(done, ['save apple', 'save apple']);
});

test('a held key acts once: letters and Enter do nothing more while held, and a held arrow keeps stepping', () => {
  const done: string[] = [];
  const held = (key: string, modifiers: Modifiers = {}) => press(key, { ...modifiers, repeat: true });
  for (const key of ['d', 'e', 'r', ' ']) handleSentenceKey(held(key), sentenceOnScreen('A', done));
  handleSentenceKey(held('R', { shiftKey: true }), sentenceOnScreen('A', done));
  handleSentenceKey(held('2', { metaKey: true }), sentenceOnScreen('A', done));
  for (const key of ['h', 'e', 'r', 's', 'd', 'a', ' ', '+']) handleWordKey(held(key), wordOnScreen('apple', done, { isSaved: true }));
  assert.deepEqual(done, [], 'holding D deletes one card, when it is pressed, not card after card');

  // The arrows and Enter (useKeyboardNavigation) follow the same rule.
  const steps: string[] = [];
  const handlers = { onArrowDown: () => steps.push('down'), onArrowLeft: () => steps.push('left'), onEnter: () => steps.push('enter') };
  const nav = (key: string, repeat: boolean): NavKeyEvent & { prevented: boolean } => {
    const event = {
      key, repeat, metaKey: false, ctrlKey: false, prevented: false,
      preventDefault() { event.prevented = true; }, stopImmediatePropagation() {},
    };
    return event;
  };
  const free = { typing: false, ime: false, guard: false };
  const heldEnter = nav('Enter', true);
  for (const event of [nav('Enter', false), heldEnter, heldEnter, nav('ArrowDown', false), nav('ArrowDown', true), nav('ArrowLeft', true)]) {
    handleNavKey(event, free, handlers);
  }
  assert.deepEqual(steps, ['enter', 'down', 'down', 'left']);
  assert.equal(heldEnter.prevented, true, 'a held Enter still keeps the browser\'s default off');
});
