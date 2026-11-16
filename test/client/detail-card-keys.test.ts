import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleSentenceKey, handleWordKey, type CardKeyEvent, type SentenceKeyHandlers, type WordKeyHandlers,
} from '../../views/detail/cardKeys.ts';
import type { StoredItem } from '../../types.ts';

type Modifiers = Partial<Pick<CardKeyEvent, 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>>;

/** A key press that records whether a shortcut kept it from the browser. */
const press = (key: string, modifiers: Modifiers = {}) => {
  const event = {
    key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers,
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
  isSentenceAutoPlaying: false,
  toggleSentenceAutoPlay: () => done.push('toggle auto-play'),
  cycleSpeed: () => done.push('cycle speed'),
  ...flags,
});

const wordOnScreen = (word: string, done: string[], flags: Partial<WordKeyHandlers> = {}): WordKeyHandlers => ({
  speakSentenceAt: index => done.push(`read example ${index + 1} of ${word}`),
  setShowHeader: update => done.push(`header ${typeof update === 'function' ? update(false) : update}`),
  title: '',
  readCardExamples: () => done.push(`read ${word}`),
  handleRemember: () => done.push(`remember ${word}`),
  handleResetSRS: () => done.push(`reset ${word}`),
  handleToggleSave: () => done.push(`toggle save ${word}`),
  handleDeleteItem: () => done.push(`delete ${word}`),
  handleArchiveItem: () => done.push(`archive ${word}`),
  isSaved: false,
  savedItemMatch: undefined,
  onUnarchive: id => done.push(`unarchive ${id}`),
  isSentenceAutoPlaying: false,
  toggleSentenceAutoPlay: () => done.push('toggle examples'),
  toggleAutoPlay: () => done.push('toggle slideshow'),
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

test('in sentence review Space starts auto-play when nothing plays, and never stops it', () => {
  const done: string[] = [];
  handleSentenceKey(press(' '), sentenceOnScreen('A', done));
  const whileAutoPlaying = press(' ');
  handleSentenceKey(whileAutoPlaying, sentenceOnScreen('A', done, { isSentenceAutoPlaying: true }));
  assert.equal(whileAutoPlaying.prevented, true);
  assert.deepEqual(done, ['toggle auto-play']);
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
  assert.deepEqual(done, ['archive apple', 'delete pear', 'unarchive fig-1']);
});

test('the word card\'s H, R, S, E, Space and + keys', () => {
  const done: string[] = [];
  const handlers = wordOnScreen('apple', done);
  for (const key of [press('h'), press('r'), press('R', { shiftKey: true }), press('s'), press('e'), press(' '), press('+'), press('=')]) {
    handleWordKey(key, handlers);
  }
  handleWordKey(press(' '), wordOnScreen('apple', done, { isSentenceAutoPlaying: true }));
  assert.deepEqual(done, [
    'header true', 'remember apple', 'reset apple', 'toggle save apple', 'read apple', 'toggle slideshow',
    'cycle speed', 'cycle speed', 'toggle examples',
  ]);
});
