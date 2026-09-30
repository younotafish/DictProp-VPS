import assert from 'node:assert/strict';
import test from 'node:test';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { buildVariantIndex, findDuplicateClusters, matchBaseWords, normalizeKey } from '../../services/wordMatch.ts';
import type { StoredItem, VocabCard } from '../../types.ts';

const vocab = (word: string, forms: string[] = []): StoredItem => {
  const data: VocabCard = {
    id: word, word, chinese: '', ipa: '', definition: word, forms,
    synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
  };
  return { data, type: 'vocab', savedAt: 0, srs: SRSAlgorithm.createNew(word, 'vocab') };
};

test('saved words match their inflections and listed forms', () => {
  const index = buildVariantIndex([vocab('run', ['ran', 'runs / running']), vocab('cat')]);
  assert.deepEqual([...matchBaseWords('ran', index)], ['run']);
  assert.deepEqual([...matchBaseWords('Running', index)], ['run']);
  assert.deepEqual([...matchBaseWords('cats', index)], ['cat']);
  assert.equal(matchBaseWords('dog', index).size, 0);
});

test('a rebuilt index follows replaced cards and leaves out deleted ones', () => {
  const run = vocab('run', ['ran']);
  const cat = vocab('cat');
  buildVariantIndex([run, cat]);

  const edited: StoredItem = { ...run, data: { ...(run.data as VocabCard), forms: ['sprinted'] } };
  const index = buildVariantIndex([edited, { ...cat, isDeleted: true }]);
  assert.deepEqual([...matchBaseWords('sprinted', index)], ['run']);
  assert.equal(matchBaseWords('ran', index).size, 0);
  assert.equal(matchBaseWords('cats', index).size, 0);
});

const matches = (query: string, index: ReturnType<typeof buildVariantIndex>) => [...matchBaseWords(query, index)];

test('a card that lists its forms is reached only by its word and those forms', () => {
  const index = buildVariantIndex([
    vocab('car', ['cars']), vocab('hop', ['hops', 'hopped', 'hopping']), vocab('see', ['sees', 'saw', 'seen', 'seeing']),
  ]);
  for (const query of ['cares', 'cared', 'caring', 'hopes', 'hoped', 'hoping', 'seed']) {
    assert.deepEqual(matches(query, index), [], query);
  }
  assert.deepEqual(matches('hopped', index), ['hop']);
  assert.deepEqual(matches('Cars', index), ['car']);
});

test('the lemmatiser fallback for cards without forms skips the collision-prone rules', () => {
  const index = buildVariantIndex(['not', 'her', 'see', 'plan', 'box', 'wish', 'hero', 'make', 'use', 'free'].map(w => vocab(w)));
  for (const query of ['notes', 'noted', 'herring', 'seed', 'planes']) assert.deepEqual(matches(query, index), [], query);
  const expected: Array<[string, string]> = [
    ['boxes', 'box'], ['wishes', 'wish'], ['heroes', 'hero'], ['makes', 'make'], ['uses', 'use'], ['used', 'use'],
    ['freed', 'free'], ['planned', 'plan'], ['seeing', 'see'],
  ];
  for (const [query, base] of expected) assert.deepEqual(matches(query, index), [base], query);
});

test("contractions keep their 's while possessives drop it", () => {
  assert.equal(normalizeKey("Let's"), "let's");
  assert.equal(normalizeKey('let’s go'), "let's go");
  assert.equal(normalizeKey("the teacher’s pet"), 'the teacher pet');
  const index = buildVariantIndex([vocab('let'), vocab('let go'), vocab('teacher')]);
  assert.deepEqual(matches("let's", index), []);
  assert.deepEqual(matches('let’s go', index), []);
  assert.deepEqual(matches("teacher's", index), ['teacher']);
});

test('a bracketed particle is optional, and annotated forms key without their labels', () => {
  const breakIn = vocab('break in(to)');
  const catchUp = vocab('catch up (with)', ['catches up (with)', 'caught up (with)']);
  const abhor = vocab('abhor', ['abhors (verb)', 'abhorring (3rd person, present participle)']);
  const index = buildVariantIndex([breakIn, catchUp, abhor, vocab('compass', ['singular: compass', 'plural: compasses']), vocab('present participle')]);
  const breakInBase = normalizeKey('break in(to)');
  for (const query of ['break in', 'break into', 'breaking into']) assert.deepEqual(matches(query, index), [breakInBase], query);
  const catchUpBase = normalizeKey('catch up (with)');
  for (const query of ['catch up', 'catch up with', 'caught up', 'catches up with']) {
    assert.deepEqual(matches(query, index), [catchUpBase], query);
  }
  assert.deepEqual(matches('abhors', index), ['abhor']);
  assert.deepEqual(matches('abhorring', index), ['abhor']);
  assert.deepEqual(matches('compasses', index), ['compass']);
  // The fragment "present participle)" left by splitting on the comma is not a form of abhor.
  assert.deepEqual(matches('present participle', index), ['present participle']);
});

test('a phrase query lemmatises each word, doubled consonants included', () => {
  const index = buildVariantIndex([vocab('run out'), vocab('set up'), vocab('look after')]);
  assert.deepEqual(matches('running out', index), ['run out']);
  assert.deepEqual(matches('setting up', index), ['set up']);
  assert.deepEqual(matches('looked after', index), ['look after']);
});

test('duplicate clusters follow what a search would pop up', () => {
  const clusters = findDuplicateClusters([
    vocab('run', ['runs', 'ran', 'running']), vocab('running'),
    vocab('not'), vocab('notes'), vocab('car', ['cars']), vocab('cares', ['care']),
    vocab('break in'), vocab('break in(to)'),
  ]);
  assert.deepEqual(clusters, [['break in', normalizeKey('break in(to)')], ['run', 'running']]);
});
