import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildNotebookList, buildNotebookRows, filterNoun, findFuzzyMatches, findLiteralMatches, findNotebookMatches,
  groupByTitle, isNotebookDue, listNoteFor, nextNotebookFilter, nextNotebookSort, notebookStats, type NotebookFilter,
  type NotebookRow,
} from '../../services/notebookList.ts';
import type { ItemGroup, SearchResult, StoredItem, UsageStatus, VocabCard } from '../../types.ts';
import { NotebookHeader } from '../../views/notebook/NotebookHeader.tsx';
import { ArchivedMatchesHeader, DueHeader } from '../../views/notebook/ListRows.tsx';
import { NotebookItem } from '../../views/notebook/NotebookItem.tsx';

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

// Reviewed once unless told otherwise: a card never reviewed is due whatever its next review says.
const srs = (id: string, type: StoredItem['type'], { due = NOW + DAY, strength = 0, reviewedAt = 0, reviews = 1 }: Options) => ({
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
  assert.deepEqual(titles(words.groups), ['mango']);
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
  assert.deepEqual((['all', 'vocab', 'phrase'] as const).map(filter => filterNoun(filter)), ['items', 'words', 'phrases']);
  // With a count, one is singular.
  assert.deepEqual((['all', 'vocab', 'phrase'] as const).map(filter => filterNoun(filter, 1)), ['item', 'word', 'phrase']);
  assert.deepEqual([0, 2, 340].map(count => filterNoun('vocab', count)), ['words', 'words', 'words']);
});

test('the saved count is the number of listed spellings under the filter, counted the same way while searching', () => {
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
    assert.equal(notebookStats(items, filter, NOW).saved, buildNotebookList(items, null, 'familiarity', filter, NOW).groups.length, filter);
  }
  assert.deepEqual((['all', 'vocab', 'phrase'] as const).map(filter => notebookStats(items, filter, NOW).saved), [3, 2, 1]);
});

test('reviewed today counts reviews of every type since local midnight, whatever the filter', () => {
  // Local wall-clock times, so the test passes in any time zone.
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
  const items: StoredItem[] = [
    vocab('late', { reviewedAt: at(14, 23, 30), reviews: 3, due: at(15, 3) }),
    vocab('reset', { reviewedAt: at(14, 23, 0), reviews: 0, due: at(14, 23, 0) }),
    phrase('on the fence', '犹豫不决', { reviewedAt: at(14, 21), due: at(15, 9) }),
    vocab('archived', { archived: true, reviewedAt: at(14, 22), reviews: 1, due: at(14, 1) }),
    { ...vocab('deleted', { reviewedAt: at(14, 22), reviews: 1, due: at(14, 1) }), isDeleted: true },
  ];
  // 23:45 the same evening: the 21:00 and 23:30 reviews count, the reset doesn't, under every filter.
  for (const filter of ['all', 'vocab', 'phrase'] as const) assert.equal(notebookStats(items, filter, at(14, 23, 45)).reviewedToday, 2, filter);
  // 08:00 the next morning: yesterday's reviews no longer count.
  assert.equal(notebookStats(items, 'all', at(15, 8)).reviewedToday, 0);
});

test('a card is due by the notebook when it was never reviewed or its review time has passed, and never when archived', () => {
  assert.equal(isNotebookDue(vocab('overdue', { due: NOW - DAY }), NOW), true);
  assert.equal(isNotebookDue(vocab('now', { due: NOW }), NOW), true);
  assert.equal(isNotebookDue(vocab('later', { due: NOW + DAY }), NOW), false);
  // Never reviewed: due at any clock, so a card saved or reset a minute ago lists with the due cards.
  for (const at of [NOW - 365 * DAY, NOW, NOW + 365 * DAY]) {
    assert.equal(isNotebookDue(vocab('new', { reviews: 0, due: NOW + 60_000 }), at), true);
  }
  assert.equal(isNotebookDue(vocab('archived', { archived: true, due: NOW - DAY }), NOW), false);
  assert.equal(isNotebookDue(vocab('archived new', { archived: true, reviews: 0 }), NOW), false);
});

test('to review counts spellings under the filter with a due sense, never-reviewed ones included', () => {
  const items: StoredItem[] = [
    // One word with three due senses counts once.
    vocab('bank', { sense: 'money', due: NOW - DAY }),
    vocab('bank', { sense: 'river', due: NOW - 2 * DAY }),
    vocab('bank', { sense: 'tilt', reviews: 0, due: NOW + DAY }),
    // A word with one sense due and one resting counts.
    vocab('run', { sense: 'move', due: NOW - DAY }),
    vocab('run', { sense: 'manage', due: NOW + DAY }),
    vocab('saved just now', { reviews: 0, due: NOW + 60_000 }),
    vocab('resting', { due: NOW + DAY }),
    vocab('archived', { archived: true, due: NOW - DAY }),
    { ...vocab('deleted', { due: NOW - DAY }), isDeleted: true },
    phrase('on the fence', '犹豫不决', { due: NOW - DAY }),
    phrase('break a leg', '祝你好运', { due: NOW + DAY }),
  ];
  assert.deepEqual((['all', 'vocab', 'phrase'] as const).map(filter => notebookStats(items, filter, NOW).toReview), [4, 3, 1]);
  // Later on, the resting senses have fallen due too.
  assert.equal(notebookStats(items, 'all', NOW + 2 * DAY).toReview, 6);
});

test('the header’s to-review count is the number of listed spellings with a Due badge at the list’s clock', () => {
  const items: StoredItem[] = [
    vocab('bank', { sense: 'money', due: NOW - DAY }),
    vocab('bank', { sense: 'river', due: NOW + DAY }),
    vocab('saved just now', { reviews: 0, due: NOW + 60_000 }),
    vocab('resting', { due: NOW + DAY }),
    vocab('soon', { due: NOW + 60_000 }),
    vocab('archived', { archived: true, due: NOW - DAY }),
    phrase('on the fence', '犹豫不决', { due: NOW - DAY }),
    phrase('break a leg', '祝你好运', { reviews: 0 }),
  ];
  for (const filter of ['all', 'vocab', 'phrase'] as NotebookFilter[]) {
    for (const now of [NOW, NOW + 60_000, NOW + 2 * DAY]) {
      const list = buildNotebookList(items, null, 'familiarity', filter, now);
      const withBadge = list.groups.filter(group => group.items.some(item => isNotebookDue(item, list.now))).length;
      assert.equal(notebookStats(items, filter, list.now).toReview, withBadge, `${filter} at ${now - NOW}`);
    }
  }
  // The archived section shows no Due badge.
  const list = buildNotebookList(items, null, 'familiarity', 'all', NOW);
  assert.ok(list.archivedGroups.every(group => group.items.every(item => !isNotebookDue(item, list.now))));
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

const rowSummary = (rows: NotebookRow[]) => rows.map(row =>
  row.type === 'due-header' || row.type === 'archived-toggle' || row.type === 'archived-header' ? `${row.key}(${row.count})` : row.key);

test('browse rows run compare banner, note, groups, due header and due groups, then the archived toggle and its open groups', () => {
  const group = (title: string) => ({ title, items: [vocab(title)] });
  const list = {
    groups: [group('bank'), group('banker')],
    dueGroups: [group('river')],
    archived: [vocab('pond', { archived: true })],
    archivedGroups: [group('pond')],
  };

  assert.deepEqual(rowSummary(buildNotebookRows(list, { searching: false, compareMode: false, showListNote: false, showArchived: false })),
    ['main:bank', 'main:banker', 'due-header(1)', 'due:river', 'archived-toggle(1)']);
  assert.deepEqual(rowSummary(buildNotebookRows(list, { searching: false, compareMode: true, showListNote: true, showArchived: true })),
    ['compare-banner', 'list-note', 'main:bank', 'main:banker', 'due-header(1)', 'due:river', 'archived-toggle(1)', 'archived:pond']);
  assert.deepEqual(rowSummary(buildNotebookRows({ groups: [], dueGroups: [], archived: [], archivedGroups: [] },
    { searching: false, compareMode: false, showListNote: true, showArchived: true })), ['list-note']);
});

test('search rows list the matches, then the archived matches open under their heading, then the due cards left out', () => {
  const items = [
    vocab('bank', { due: NOW + DAY }),
    vocab('bankrupt', { archived: true }),
    vocab('embankment', { archived: true, sense: 'wall' }),
    vocab('embankment', { archived: true, sense: 'road' }),
    vocab('river', { due: NOW - DAY }),
  ];
  const list = buildNotebookList(items, findNotebookMatches(items, 'bank'), 'familiarity', 'all', NOW);
  // N counts the archived spellings listed, whatever the toggle says.
  for (const showArchived of [false, true]) {
    assert.deepEqual(rowSummary(buildNotebookRows(list, { searching: true, compareMode: false, showListNote: false, showArchived })),
      ['main:bank', 'archived-header(2)', 'archived:bankrupt', 'archived:embankment', 'due-header(1)', 'due:river']);
  }
  // With nothing archived among the matches there's no heading, and no archived toggle either.
  const unarchived = buildNotebookList(items, findNotebookMatches(items, 'river'), 'familiarity', 'all', NOW);
  assert.deepEqual(rowSummary(buildNotebookRows(unarchived, { searching: true, compareMode: false, showListNote: false, showArchived: true })),
    ['main:river']);
});

test('the list orders by the clock it is given and carries that clock, so its rows count Due from the same instant', () => {
  const items = [
    vocab('later', { due: NOW + 3 * DAY }),
    vocab('soon', { due: NOW + 60_000, strength: 10 }),
    vocab('overdue', { due: NOW - DAY, strength: 50 }),
  ];
  const before = buildNotebookList(items, null, 'familiarity', 'all', NOW);
  assert.equal(before.now, NOW);
  assert.deepEqual(titles(before.groups), ['overdue', 'soon', 'later']);
  // A minute later 'soon' has fallen due and joins the due cards, weakest first.
  const after = buildNotebookList(items, null, 'familiarity', 'all', NOW + 60_000);
  assert.equal(after.now, NOW + 60_000);
  assert.deepEqual(titles(after.groups), ['soon', 'overdue', 'later']);
});

test('a rebuild keeps the earlier object of every group whose senses are unchanged, section by section', () => {
  const items = [
    vocab('bank', { sense: 'money', due: NOW - DAY }),
    vocab('bank', { sense: 'river', due: NOW + DAY }),
    vocab('apple', { due: NOW + 2 * DAY }),
    vocab('pear', { due: NOW + 3 * DAY }),
    vocab('zebra', { archived: true }),
  ];
  const first = buildNotebookList(items, null, 'familiarity', 'all', NOW);
  // A review replaces apple's wrapper; nothing else changes.
  const reviewed = items.map(item => (item.data.id === 'apple:' ? { ...item, srs: { ...item.srs, totalReviews: 1 } } : item));
  const second = buildNotebookList(reviewed, null, 'familiarity', 'all', NOW, first);
  assert.deepEqual(titles(second.groups), ['bank', 'apple', 'pear']);
  assert.equal(second.groups[0], first.groups[0]);
  assert.notEqual(second.groups[1], first.groups[1]);
  assert.equal(second.groups[1].items[0], reviewed[2]);
  assert.equal(second.groups[2], first.groups[2]);
  assert.equal(second.archivedGroups[0], first.archivedGroups[0]);

  // A group whose senses change, by one more or one fewer, is new; a search's due section reuses only its own.
  const fewer = buildNotebookList(reviewed.filter(item => item.data.id !== 'bank:river'), null, 'familiarity', 'all', NOW, second);
  assert.notEqual(fewer.groups[0], second.groups[0]);
  assert.deepEqual(fewer.groups[0].items.map(item => item.data.id), ['bank:money']);
  const searching = buildNotebookList(reviewed, findNotebookMatches(reviewed, 'pear'), 'familiarity', 'all', NOW, second);
  assert.deepEqual(titles(searching.dueGroups), ['bank']);
  assert.notEqual(searching.dueGroups[0], second.groups[0]);
  assert.equal(searching.groups[0], second.groups[2]);
});

test('at one clock, a content change rebuilds the list in the same order and keeps the other rows’ groups', () => {
  const items = [
    vocab('overdue', { due: NOW - DAY, strength: 50 }),
    vocab('soon', { due: NOW + 60_000 }),
    vocab('later', { due: NOW + 3 * DAY }),
  ];
  const first = buildNotebookList(items, null, 'familiarity', 'all', NOW);
  assert.deepEqual(titles(first.groups), ['overdue', 'soon', 'later']);
  // An enrichment lands on 'later' and a sync acknowledges 'overdue' a minute on, after 'soon' fell due: at the list's
  // clock nothing moves, and only the changed rows get new groups.
  const enriched = items.map(item => (item.data.id === 'later:' ? { ...item, data: { ...item.data, history: 'Old English' } } : item));
  const acknowledged = enriched.map(item => (item.data.id === 'overdue:' ? { ...item, updatedAt: NOW + 60_000 } : item));
  const second = buildNotebookList(acknowledged, null, 'familiarity', 'all', first.now, first);
  assert.deepEqual(titles(second.groups), ['overdue', 'soon', 'later']);
  assert.equal(second.groups[1], first.groups[1]);
  assert.notEqual(second.groups[2], first.groups[2]);
  // When the clock moves on (a view change), 'soon' joins the due cards.
  assert.deepEqual(titles(buildNotebookList(acknowledged, null, 'familiarity', 'all', NOW + 60_000, second).groups), ['soon', 'overdue', 'later']);
});

test('a card saved or reset after the list’s clock lists with the due cards at once, in browse and in a search’s due block', () => {
  const items = [
    vocab('overdue', { due: NOW - DAY, strength: 50 }),
    vocab('resting', { due: NOW + DAY }),
    // Saved from the AI card a minute after the list read its clock: due now by its own schedule, not yet by the list's.
    vocab('just saved', { reviews: 0, due: NOW + 60_000 }),
    vocab('archived new', { reviews: 0, archived: true }),
  ];
  assert.deepEqual(titles(buildNotebookList(items, null, 'familiarity', 'all', NOW).groups), ['just saved', 'overdue', 'resting']);
  const searching = buildNotebookList(items, findNotebookMatches(items, 'resting'), 'familiarity', 'all', NOW);
  assert.deepEqual(titles(searching.dueGroups), ['just saved', 'overdue']);
});

test('the header line names what the filter lists, then reviewed today and to review; the due block names it too', () => {
  const noop = () => {};
  const header = (savedCount: number, filterMode: NotebookFilter) => renderToStaticMarkup(createElement(NotebookHeader, {
    headerRef: null, savedCount, reviewedToday: 12, toReviewCount: 340, isOnline: true, toolsMenu: null, empty: false,
    compareMode: false, onToggleCompare: noop, filterMode, onCycleFilter: noop, sortMode: 'familiarity',
    onCycleSort: noop, user: null, onSignIn: noop, onSignOut: noop, children: null,
  }));
  const line = (text: string) => `<p class="text-xs text-slate-500 font-medium truncate">${text}</p>`;
  assert.ok(header(1532, 'vocab').includes(line('1532 words · 12 reviewed today · 340 to review')));
  assert.ok(header(1, 'vocab').includes(line('1 word · 12 reviewed today · 340 to review')));
  assert.ok(header(87, 'phrase').includes(line('87 phrases · 12 reviewed today · 340 to review')));
  assert.ok(header(1619, 'all').includes(line('1619 items · 12 reviewed today · 340 to review')));
  const due = (count: number, filter: NotebookFilter) => renderToStaticMarkup(createElement(DueHeader, { count, filter }));
  assert.match(due(1, 'vocab'), />1 word to revisit</);
  assert.match(due(3, 'phrase'), />3 phrases to revisit</);
  assert.match(due(2, 'all'), />2 items to revisit</);
});

test('an archived card says Archived on a neutral strip instead of Due, and a search heads its archived matches', () => {
  const noop = () => {};
  const card = (item: StoredItem, isDue: boolean) => renderToStaticMarkup(createElement(NotebookItem, {
    item, isDue, itemIndex: 0, onOpen: noop, onDelete: noop,
  }));
  const STRIP = /<div class="absolute left-0 top-0 bottom-0 w-1\.5 ([^"]+)"><\/div>/;
  const archived = { ...vocab('pond', { archived: true, due: NOW - DAY }), srs: { ...vocab('pond').srs, interval: 60 * 24 * 60 } };
  const archivedHtml = card(archived, isNotebookDue(archived, NOW));
  assert.match(archivedHtml, />Archived<\/span>/);
  assert.doesNotMatch(archivedHtml, />Due<\/span>/);
  assert.equal(archivedHtml.match(STRIP)?.[1], 'bg-slate-200');

  const dueHtml = card(vocab('river', { due: NOW - DAY }), true);
  assert.match(dueHtml, />Due<\/span>/);
  assert.doesNotMatch(dueHtml, />Archived<\/span>/);
  assert.equal(dueHtml.match(STRIP)?.[1], 'bg-orange-400');
  const learned = { ...vocab('lake'), srs: { ...vocab('lake').srs, interval: 60 * 24 * 60 } };
  assert.equal(card(learned, false).match(STRIP)?.[1], 'bg-emerald-400');

  assert.match(renderToStaticMarkup(createElement(ArchivedMatchesHeader, { count: 2 })), />Archived matches · 2</);
});
