import assert from 'node:assert/strict';
import test from 'node:test';
import { sentenceSourceResolver } from '../../services/sentenceSource.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

const card = (id: string, word: string, sense: string, forms: string[] = [], extra: { isDeleted?: boolean } = {}): StoredItem =>
  ({ type: 'vocab', savedAt: 1, data: { id, word, sense, forms } as Partial<VocabCard>, ...extra }) as unknown as StoredItem;

test('a sentence opens the card with its word and sense, else the first card with its word', () => {
  const find = sentenceSourceResolver([
    card('fast', 'making time', 'idiom: progressing at a good speed'),
    card('busy', 'Making Time', 'idiom: finding time despite a busy schedule'),
  ]);
  assert.equal(find('making time', 'idiom: finding time despite a busy schedule')?.data.id, 'busy');
  assert.equal(find(' Making time ', 'a sense no card has')?.data.id, 'fast');
  assert.equal(find('making time')?.data.id, 'fast');
});

test('a word saved in an inflected form reaches the card renamed to its base form through its forms', () => {
  const find = sentenceSourceResolver([
    card('speed', 'make time', 'idiom: progress quickly', ['makes time', 'made time, making time']),
    card('busy', 'make time', 'idiom: find time despite a busy schedule', ['makes time', 'made time', 'making time']),
    card('work', 'work with', 'phrasal verb: collaborate', ['works with', 'worked with', 'working with']),
  ]);
  assert.equal(find('making time', 'idiom: find time despite a busy schedule')?.data.id, 'busy');
  assert.equal(find('Making time', 'idiom: finding time for something')?.data.id, 'speed', 'without its sense, the first card that lists the form');
  assert.equal(find('working with', 'phrasal verb: collaborating or cooperating')?.data.id, 'work');
});

test('a card spelled as the word wins over one that lists it as a form', () => {
  const find = sentenceSourceResolver([
    card('leave', 'leave', 'verb: go away', ['leaves', 'left', 'leaving']),
    card('left', 'left', 'adjective: on the west side'),
  ]);
  assert.equal(find('left')?.data.id, 'left');
});

test('deleted cards, other item types and unknown words find nothing', () => {
  const find = sentenceSourceResolver([
    card('gone', 'make time', 'idiom', ['making time'], { isDeleted: true }),
    { type: 'phrase', savedAt: 1, data: { id: 'p', query: 'making time' } } as unknown as StoredItem,
  ]);
  assert.equal(find('making time'), undefined);
  assert.equal(find('make time'), undefined);
  assert.equal(find(''), undefined);
  assert.equal(find(undefined), undefined);
});
