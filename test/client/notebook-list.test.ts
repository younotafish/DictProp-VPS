import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNotebookList, buildNotebookRows, countSavedSpellings, filterNoun, findFuzzyMatches, findLiteralMatches, findNotebookMatches,
  groupByTitle, listNoteFor, nextNotebookFilter, nextNotebookSort, notebookStats, type NotebookRow,
} from '../../services/notebookList.ts';
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
  reviewedAt?: number;
  reviews?: number;
}

const srs = (id: string, type: StoredItem['type'], { due = NOW + DAY, strength = 0, reviewedAt = 0, reviews = 0 }: Options) => ({
  id,
  type,
  nextReview: due,
  interval: 0,
  memoryStrength: strength,
  lastReviewDate: reviewedAt,
  totalReviews: reviews,
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

test('the filter button cycles all, words, phrases; the sort button toggles; each filter names what it lists', () => {
  assert.equal(nextNotebookFilter('all'), 'vocab');
  assert.equal(nextNotebookFilter('vocab'), 'phrase');
  assert.equal(nextNotebookFilter('phrase'), 'all');
  assert.equal(nextNotebookSort('familiarity'), 'alphabetical');
  assert.equal(nextNotebookSort('alphabetical'), 'familiarity');
  assert.deepEqual((['all', 'vocab', 'phrase'] as const).map(filterNoun), ['items', 'words', 'phrases']);
});

test('the saved count is the number of listed spellings, counted the same way while searching', () => {
  const items: StoredItem[] = [
    vocab('Bank', { sense: 'money' }),
    vocab('bank', { sense: 'river' }),
    vocab('apple'),
    vocab('zebra', { archived: true }),
    { ...vocab('gone'), isDeleted: true },
    phrase('on the fence', '犹豫不决'),
    phrase('break a leg', '祝你好运', { archived: true }),
  ];
  for (const filter of ['all', 'vocab', 'phrase'] as const) {
    assert.equal(countSavedSpellings(items, filter), buildNotebookList(items, null, 'familiarity', filter, NOW).groups.length, filter);
  }
  assert.equal(countSavedSpellings(items, 'all'), 3);
  assert.equal(countSavedSpellings(items, 'vocab'), 2);
  assert.equal(countSavedSpellings(items, 'phrase'), 1);
});

test('reviewed today counts reviews since local midnight, and due counts every unarchived sense due at that time', () => {
  // Local wall-clock times, so the test passes in any time zone.
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
  const items: StoredItem[] = [
    vocab('late', { reviewedAt: at(14, 23, 30), reviews: 3, due: at(15, 3) }),
    vocab('reset', { reviewedAt: at(14, 23, 0), reviews: 0, due: at(14, 23, 0) }),
    phrase('on the fence', '犹豫不决', { due: at(14, 9) }),
    vocab('archived', { archived: true, reviewedAt: at(14, 22), reviews: 1, due: at(14, 1) }),
    { ...vocab('deleted', { reviewedAt: at(14, 22), reviews: 1, due: at(14, 1) }), isDeleted: true },
  ];
  // 23:45 the same evening: the 23:30 review counts; 'late' isn't due until 03:00.
  assert.deepEqual(notebookStats(items, at(14, 23, 45)), { reviewedToday: 1, dueCount: 2 });
  // 08:00 the next morning: yesterday's review no longer counts, and 'late' fell due overnight.
  assert.deepEqual(notebookStats(items, at(15, 8)), { reviewedToday: 0, dueCount: 3 });
});

test('the list note explains an empty list and offers the way out, but says nothing while results are listed or a search is unsettled', () => {
  const note = (overrides: Partial<Parameters<typeof listNoteFor>[0]>) => listNoteFor({
    searchQuery: '', searchSettled: false, groupCount: 0, archivedCount: 0, filter: 'all', canLookUp: true, ...overrides,
  });
  assert.equal(note({ groupCount: 1 }), null);
  assert.equal(note({ groupCount: 1, searchQuery: 'bank', searchSettled: true }), null);
  assert.equal(note({ searchQuery: 'bank', searchSettled: false }), null);
  // An empty notebook under the 'all' filter has its own screen, so the list says nothing.
  assert.equal(note({}), null);

  assert.deepEqual(note({ filter: 'vocab' }), { message: 'No words saved yet.', offerLookUp: false, offerShowAll: true });
  assert.deepEqual(note({ archivedCount: 2 }), { message: 'All your items are archived.', offerLookUp: false, offerShowAll: false });
  assert.deepEqual(note({ archivedCount: 2, filter: 'phrase' }), { message: 'All your phrases are archived.', offerLookUp: false, offerShowAll: true });
  assert.deepEqual(
    note({ searchQuery: 'bank', searchSettled: true, filter: 'vocab' }),
    { message: 'No saved words match “bank”.', offerLookUp: true, offerShowAll: true },
  );
  assert.deepEqual(
    note({ searchQuery: 'bank', searchSettled: true, archivedCount: 1 }),
    { message: 'Only archived items match “bank”.', offerLookUp: true, offerShowAll: false },
  );
  assert.equal(note({ searchQuery: 'bank', searchSettled: true, canLookUp: false })?.offerLookUp, false);
});

test('rows run compare banner, note, groups, due header and due groups, then the archived toggle and its open groups', () => {
  const group = (title: string) => ({ title, items: [vocab(title)] });
  const list = {
    groups: [group('bank'), group('banker')],
    dueGroups: [group('river')],
    archived: [vocab('pond', { archived: true })],
    archivedGroups: [group('pond')],
  };
  const summary = (rows: NotebookRow[]) => rows.map(row =>
    row.type === 'group' ? `${row.key}#${row.groupIndex}` : row.type === 'due-header' || row.type === 'archived-toggle' ? `${row.key}(${row.count})` : row.key);

  assert.deepEqual(summary(buildNotebookRows(list, { compareMode: false, showListNote: false, showArchived: false })),
    ['main:bank#0', 'main:banker#1', 'due-header(1)', 'due:river#0', 'archived-toggle(1)']);
  assert.deepEqual(summary(buildNotebookRows(list, { compareMode: true, showListNote: true, showArchived: true })),
    ['compare-banner', 'list-note', 'main:bank#0', 'main:banker#1', 'due-header(1)', 'due:river#0', 'archived-toggle(1)', 'archived:pond#0']);
  assert.deepEqual(summary(buildNotebookRows({ groups: [], dueGroups: [], archived: [], archivedGroups: [] },
    { compareMode: false, showListNote: true, showArchived: true })), ['list-note']);
});
