import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNotebookList, findFuzzyMatches, findLiteralMatches, findNotebookMatches, groupByTitle } from '../../services/notebookList.ts';
import type { ItemGroup, SearchResult, StoredItem, UsageStatus, VocabCard } from '../../types.ts';

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

interface Options {
  sense?: string;
  chinese?: string;
  status?: UsageStatus;
  due?: number;
  strength?: number;
  archived?: boolean;
}

const srs = (id: string, type: StoredItem['type'], { due = NOW + DAY, strength = 0 }: Options) => ({
  id,
  type,
  nextReview: due,
  interval: 0,
  memoryStrength: strength,
  lastReviewDate: 0,
  totalReviews: 0,
  correctStreak: 0,
  stability: 0,
});

const vocab = (word: string, options: Options = {}): StoredItem => {
  const id = `${word}:${options.sense ?? ''}`;
  const data: VocabCard = {
    id,
    word,
    sense: options.sense,
    chinese: options.chinese ?? '',
    ipa: '',
    definition: word,
    synonyms: [],
    antonyms: [],
    confusables: [],
    examples: [],
    history: '',
    register: '',
    mnemonic: '',
    ...(options.status ? { usageAudit: { status: options.status, reason: options.status, confidence: 'high' as const, auditedAt: 1 } } : {}),
  };
  return { data, type: 'vocab', savedAt: 1, isArchived: options.archived, srs: srs(id, 'vocab', options) };
};

const phrase = (query: string, translation: string, options: Options = {}): StoredItem => {
  const data: SearchResult = {
    id: query,
    query,
    translation,
    grammar: '',
    visualKeyword: '',
    pronunciation: '',
    vocabs: [],
    timestamp: 1,
  };
  return { data, type: 'phrase', savedAt: 1, isArchived: options.archived, srs: srs(query, 'phrase', options) };
};

const ids = (items: StoredItem[]) => items.map(item => item.data.id);
const titles = (groups: ItemGroup[]) => groups.map(group => group.title);

test('groups keep first-appearance order and put the most useful sense first', () => {
  const groups = groupByTitle([
    vocab('Bank', { sense: 'river', status: 'rare_or_dated' }),
    vocab('apple'),
    vocab('bank', { sense: 'money', status: 'modern_american' }),
  ]);
  assert.deepEqual(titles(groups), ['bank', 'apple']);
  assert.deepEqual(ids(groups[0].items), ['bank:money', 'Bank:river']);
});

test('the familiarity sort lists due words weakest first, then upcoming words by next review', () => {
  const items = [
    vocab('later', { due: NOW + 3 * DAY }),
    vocab('strong', { due: NOW - DAY, strength: 80 }),
    vocab('soon', { due: NOW + DAY }),
    vocab('weak', { due: NOW - DAY, strength: 10 }),
    vocab('overdue', { due: NOW - 5 * DAY, strength: 10 }),
  ];
  const list = buildNotebookList(items, null, 'familiarity', 'all', NOW);
  assert.deepEqual(titles(list.groups), ['overdue', 'weak', 'strong', 'soon', 'later']);
  assert.deepEqual(list.dueGroups, []);

  const alphabetical = buildNotebookList(items, null, 'alphabetical', 'all', NOW);
  assert.deepEqual(titles(alphabetical.groups), ['later', 'overdue', 'soon', 'strong', 'weak']);
});

test('archived items form their own alphabetical section and the type filter applies to both', () => {
  const items = [
    vocab('zebra', { archived: true }),
    phrase('break a leg', '祝你好运', { archived: true }),
    vocab('apple', { archived: true }),
    vocab('mango'),
    phrase('on the fence', '犹豫不决'),
  ];
  const all = buildNotebookList(items, null, 'familiarity', 'all', NOW);
  assert.deepEqual(titles(all.groups), ['mango', 'on the fence']);
  assert.deepEqual(titles(all.archivedGroups), ['apple', 'break a leg', 'zebra']);

  const words = buildNotebookList(items, null, 'familiarity', 'vocab', NOW);
  assert.deepEqual(ids(words.active), ['mango:']);
  assert.deepEqual(ids(words.archived), ['apple:', 'zebra:']);
});

test('search matches words, phrases and Chinese, and brings along the other senses of a match', () => {
  const items = [
    vocab('bank', { sense: 'money', chinese: '银行' }),
    vocab('bank', { sense: 'river', chinese: '河岸' }),
    vocab('embankment', { chinese: '堤岸' }),
    vocab('apple', { chinese: '苹果' }),
    phrase('break the bank', '花大钱'),
  ];
  assert.deepEqual(ids(findNotebookMatches(items, ' BANK ')), ['bank:money', 'bank:river', 'embankment:', 'break the bank']);
  assert.deepEqual(ids(findNotebookMatches(items, '银行')), ['bank:money', 'bank:river']);
  assert.deepEqual(ids(findNotebookMatches(items, '花大钱')), ['break the bank']);
  assert.equal(findNotebookMatches(items, '  '), items);
});

test('while searching, due items outside the results follow them, weakest first', () => {
  const items = [
    vocab('bank', { due: NOW - DAY }),
    vocab('river', { due: NOW - DAY, strength: 50 }),
    vocab('stream', { due: NOW - DAY, strength: 5 }),
    vocab('lake', { due: NOW + DAY }),
    vocab('pond', { due: NOW - DAY, archived: true }),
  ];
  const list = buildNotebookList(items, findNotebookMatches(items, 'bank'), 'familiarity', 'all', NOW);
  assert.deepEqual(titles(list.groups), ['bank']);
  assert.deepEqual(titles(list.dueGroups), ['stream', 'river']);
});

test('a search without substring hits falls back to fuzzy spelling so typos still match', () => {
  const items = [vocab('accommodate'), vocab('recommend'), vocab('apple')];
  assert.deepEqual(ids(findNotebookMatches(items, 'acommodate')), ['accommodate:']);
  assert.deepEqual(ids(findNotebookMatches(items, 'xyzzy')), []);
});

test('literal matching reports a query nothing contains as null, so the caller can wait to scan fuzzily', () => {
  const items = [vocab('accommodate'), vocab('apple')];
  assert.equal(findLiteralMatches(items, 'acommodate'), null);
  assert.deepEqual(ids(findLiteralMatches(items, ' APP ') ?? []), ['apple:']);
});

test('the fuzzy index keeps up with spellings added and removed after it was built', () => {
  const items = [vocab('accommodate'), vocab('apple')];
  assert.deepEqual(ids(findFuzzyMatches(items, 'acommodate')), ['accommodate:']);
  const reviewed = items.map(item => ({ ...item, srs: { ...item.srs!, totalReviews: 1 } }));
  assert.deepEqual(ids(findFuzzyMatches(reviewed, 'acommodate')), ['accommodate:']);
  assert.deepEqual(ids(findFuzzyMatches([...items, vocab('necessary')], 'neccessary')), ['necessary:']);
  assert.deepEqual(ids(findFuzzyMatches(items, 'neccessary')), []);
});

test('substring hits leave out near misses the fuzzy fallback would find', () => {
  const items = [vocab('affect'), vocab('effect')];
  assert.deepEqual(ids(findNotebookMatches(items, 'affect')), ['affect:']);
});
