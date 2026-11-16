import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNotebookList, findFuzzyMatchesRanked, type NotebookSort } from '../../services/notebookList.ts';
import { SEARCH_TIER, findSearchCandidates, rankSearchMatches } from '../../services/notebook/searchRank.ts';
import { buildVariantIndex, matchBaseWords } from '../../services/wordMatch.ts';
import type { ItemGroup, SearchResult, StoredItem, VocabCard } from '../../types.ts';

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

interface Options { sense?: string; forms?: string[]; chinese?: string; due?: number; strength?: number; archived?: boolean }

const vocab = (word: string, { sense, forms, chinese = '', due = NOW + DAY, strength = 0, archived }: Options = {}): StoredItem => {
  const id = `${word}:${sense ?? ''}`;
  const data: VocabCard = {
    id, word, sense, forms, chinese, ipa: '', definition: word, synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '',
  };
  return {
    data, type: 'vocab', savedAt: 1, isArchived: archived,
    srs: { id, type: 'vocab', nextReview: due, interval: 0, memoryStrength: strength, lastReviewDate: 0, totalReviews: 1, correctStreak: 0, stability: 0 },
  };
};

const phrase = (query: string, translation: string): StoredItem => {
  const data: SearchResult = { id: query, query, translation, grammar: '', visualKeyword: '', pronunciation: '', vocabs: [], timestamp: 1 };
  return {
    data, type: 'phrase', savedAt: 1,
    srs: { id: query, type: 'phrase', nextReview: NOW + DAY, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 1, correctStreak: 0, stability: 0 },
  };
};

const titles = (groups: ItemGroup[]) => groups.map(group => group.title);

/** The notebook's search as useNotebookSearch runs it: candidates, their ranks, then the list. */
const search = (items: StoredItem[], query: string, sort: NotebookSort = 'familiarity') => {
  // useLibraryViews' matchSavedBases: the variant index over the words and phrases.
  const bases = matchBaseWords(query, buildVariantIndex(items));
  const candidates = findSearchCandidates(items, query, bases);
  if (candidates) return buildNotebookList(items, candidates, sort, 'all', NOW, null, rankSearchMatches(candidates, query, bases));
  const fuzzy = findFuzzyMatchesRanked(items, query);
  return buildNotebookList(items, fuzzy.matches, sort, 'all', NOW, null, rankSearchMatches(fuzzy.matches, query, bases, fuzzy.order));
};

const RUN = { forms: ['runs', 'running', 'ran'] };

test('the word typed comes first, then words starting with it, words inside phrases, and anything containing it', () => {
  const items = [
    vocab('embankment'),
    phrase('break the bank', '花大钱'),
    vocab('bankrupt'),
    vocab('bank', { sense: 'money' }),
    vocab('bank', { sense: 'river' }),
  ];
  const list = search(items, 'bank');
  assert.deepEqual(titles(list.groups), ['bank', 'bankrupt', 'break the bank', 'embankment']);
  // Every sense of the typed word comes with it.
  assert.deepEqual(list.groups[0].items.map(item => item.data.id).sort(), ['bank:money', 'bank:river']);
});

test('an inflected query lists its saved base word first, after the word itself when that is saved too', () => {
  const unsaved = [vocab('orange'), vocab('random'), vocab('run', RUN), vocab('walk')];
  assert.deepEqual(titles(search(unsaved, 'ran').groups), ['run', 'random', 'orange']);

  const saved = [...unsaved, vocab('ran', { forms: ['run'] })];
  assert.deepEqual(titles(search(saved, 'ran').groups), ['ran', 'run', 'random', 'orange']);

  const leave = [vocab('leave', { forms: ['leaves', 'leaving', 'left'] }), vocab('left', { forms: ['lefts'] })];
  assert.deepEqual(titles(search(leave, 'left').groups), ['left', 'leave']);
  const find = [vocab('find', { forms: ['finds', 'finding', 'found'] }), vocab('found', { forms: ['founded', 'founding'] })];
  assert.deepEqual(titles(search(find, 'found').groups), ['found', 'find']);
});

test('base words join the substring hits, and a query neither finds waits for the fuzzy scan', () => {
  const items = [vocab('run', RUN), vocab('ranch')];
  const bases = matchBaseWords('ran', buildVariantIndex(items));
  assert.deepEqual([...bases], ['run']);
  assert.deepEqual(findSearchCandidates(items, 'ran', bases)?.map(item => item.data.id), ['run:', 'ranch:']);
  assert.equal(findSearchCandidates(items, 'xyzzy', new Set()), null);
  // With no base words, as for a query that inflects no saved word, only the substring hits.
  assert.deepEqual(findSearchCandidates(items, 'ran', new Set())?.map(item => item.data.id), ['ranch:']);
});

test('every sense of a spelling takes its best tier, so a word with one inflected sense lists whole', () => {
  const items = [vocab('random'), vocab('run', { sense: 'move', ...RUN }), vocab('run', { sense: 'manage' })];
  const list = search(items, 'ran');
  assert.deepEqual(titles(list.groups), ['run', 'random']);
  assert.equal(list.groups[0].items.length, 2);
  const ranks = rankSearchMatches(items, 'ran', new Set(['run']));
  assert.equal(ranks.get('run'), SEARCH_TIER.base * 1e6);
  assert.equal(ranks.get('random'), SEARCH_TIER.prefix * 1e6);
});

test('a hit only in the Chinese or the translation ranks after every spelling hit', () => {
  const items = [vocab('money', { chinese: '钱 (bank notes)' }), vocab('embankment'), phrase('break the bank', '花大钱')];
  assert.deepEqual(titles(search(items, 'bank').groups), ['break the bank', 'embankment', 'money']);
  assert.equal(rankSearchMatches(items, 'bank', new Set()).get('money'), SEARCH_TIER.otherField * 1e6);
});

test('fuzzy-only hits keep Fuse’s order, whatever the sort', () => {
  const items = [vocab('accommodation'), vocab('accommodate'), vocab('apple')];
  const fuzzy = findFuzzyMatchesRanked(items, 'acommodate');
  assert.ok(fuzzy.order.length >= 2);
  for (const sort of ['familiarity', 'alphabetical'] as const) {
    assert.deepEqual(titles(search(items, 'acommodate', sort).groups), fuzzy.order, sort);
  }
  assert.equal(fuzzy.order[0], 'accommodate');
});

test('within a tier the list’s sort decides: due and weakest first, or A–Z', () => {
  const items = [
    vocab('bank'),
    vocab('banana', { due: NOW - DAY, strength: 10 }),
    vocab('basket', { due: NOW - DAY, strength: 5 }),
    vocab('ba'),
  ];
  assert.deepEqual(titles(search(items, 'ba').groups), ['ba', 'basket', 'banana', 'bank']);
  assert.deepEqual(titles(search(items, 'ba', 'alphabetical').groups), ['ba', 'banana', 'bank', 'basket']);
});

test('an archived base word is listed with the archived matches, ranked the same way', () => {
  const items = [vocab('run', { ...RUN, archived: true }), vocab('random'), vocab('ranch', { archived: true })];
  const list = search(items, 'ran');
  assert.deepEqual(titles(list.groups), ['random']);
  assert.deepEqual(titles(list.archivedGroups), ['run', 'ranch']);
});
