import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSentenceIndex, searchSentences } from '../../services/sentenceSearch.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { StoredItem } from '../../types.ts';

function sentence(id: string, text: string, sourceWord = ''): StoredItem {
  return { type: 'sentence', savedAt: 0, data: { id, text, sourceWord }, srs: SRSAlgorithm.createNew(id, 'sentence') };
}

const search = (items: StoredItem[], query: string, limit?: number) =>
  searchSentences(query, buildSentenceIndex(items), limit).map(item => item.data.id);

test('a typed word matches the start of a word, not the inside of one', () => {
  const items = [
    sentence('nice', 'That was a nice try.'),
    sentence('office', 'She left the office early.'),
    sentence('ice', 'He tried to break the ice.'),
    sentence('iced', 'I ordered an iced latte.'),
  ];
  assert.deepEqual(search(items, 'ice'), ['ice', 'iced']);
});

test('whole-word hits rank ahead of longer words the query only begins, even shorter ones', () => {
  const items = [
    sentence('prefix', 'Icebergs drift.'),
    sentence('whole', 'The pond finally froze into solid ice this week.'),
  ];
  assert.deepEqual(search(items, 'ice'), ['whole', 'prefix']);
});

test('several words match in any order, and the whole query as a phrase ranks first', () => {
  const items = [
    sentence('scattered', 'The ice made it hard to break a trail.'),
    sentence('phrase', 'Jokes can break the ice at a long meeting with strangers.'),
    sentence('missing', 'Try not to break anything.'),
  ];
  assert.deepEqual(search(items, 'break ice'), ['scattered', 'phrase']);
  assert.deepEqual(search(items, 'break the ice'), ['phrase', 'scattered']);
});

test('a fragment that starts no word still finds the words that contain it', () => {
  const items = [
    sentence('station', 'Meet me at the station.'),
    sentence('other', 'See you tomorrow.'),
  ];
  assert.deepEqual(search(items, 'tion'), ['station']);
});

test('accents, case, curly apostrophes, markup and the source word are all searchable', () => {
  const items = [
    sentence('saute', 'She {{sautéed}} the onions.'),
    sentence('dont', 'I don’t know yet.'),
    sentence('source', 'It went off without a hitch.', 'hitch'),
    sentence('marked', 'That was an [[unprecedented]] result.'),
  ];
  assert.deepEqual(search(items, 'SAUTE'), ['saute']);
  assert.deepEqual(search(items, "don't"), ['dont']);
  assert.deepEqual(search(items, 'don’t'), ['dont']);
  assert.deepEqual(search(items, 'hitch'), ['source']);
  assert.deepEqual(search(items, 'unprecedented result'), ['marked']);
});

test('text in a script without spaces matches anywhere, and punctuation-led fragments inside words', () => {
  const items = [
    sentence('chinese', '我喜欢吃冰淇淋。'),
    sentence('cold', 'The water was ice-cold.'),
  ];
  assert.deepEqual(search(items, '冰淇淋'), ['chinese']);
  assert.deepEqual(search(items, '-cold'), ['cold']);
});

test('inside-word matches and then fuzzy matches are fallbacks, and the limit caps every tier', () => {
  const items = [
    sentence('a', 'An apple a day keeps the doctor away.'),
    sentence('b', 'Apples are sweet.'),
    sentence('c', 'He ate an apple pie.'),
    sentence('maple', 'The maple leaf turned red.'),
  ];
  assert.deepEqual(search(items, 'apple').sort(), ['a', 'b', 'c']);
  assert.deepEqual(search(items, 'aple'), ['maple']);
  assert.deepEqual(search(items, 'appke').sort(), ['a', 'b', 'c']);
  assert.equal(search(items, 'apple', 2).length, 2);
  assert.deepEqual(search(items, '   '), []);
});
