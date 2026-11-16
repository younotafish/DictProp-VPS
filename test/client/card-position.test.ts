import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ItemGroup, SRSData, StoredItem, VocabCard } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { buildNotebookList, isNotebookDue, notebookStats } from '../../services/notebookList.ts';
import { getMasteryColors } from '../../components/mastery.tsx';
import { buildToReviewFrom, cardPositionLine } from '../../views/detail/cardPosition.ts';
import { WordCardHeader } from '../../views/detail/WordCardHeader.tsx';

// The card view's sense of place (UX-18): its header's Got it, or Unarchive with an Archived chip on an archived card,
// and the line at the end of a card, whose 'to review after this' counts by the rule the Notebook's Due badges and
// its header's 'to review' count follow.

type HeaderProps = ComponentProps<typeof WordCardHeader>;
const header = (props: Partial<HeaderProps> = {}) => {
  const srs = { ...SRSAlgorithm.createNew('apple-1', 'vocab', 0), totalReviews: 2, memoryStrength: 40 };
  const mastery = SRSAlgorithm.getMasteryLevel(srs);
  return renderToStaticMarkup(createElement(WordCardHeader, {
    showHeader: true, onClose: () => {}, itemCount: 1, itemIndex: 0, onRefresh: () => {}, isSaved: true, onDelete: () => {},
    onSave: () => {}, onRemember: () => {}, onUnarchive: () => {}, moreActionsRef: { current: null }, showActionMenu: false,
    onToggleActionMenu: () => {}, stats: { srs, mastery, colors: getMasteryColors(mastery.color) }, savedItems: [], ...props,
  }));
};
/** The titles of the header's buttons, in order. */
const buttonTitles = (html: string) => [...html.matchAll(/<button[^>]*>/g)].map(match => match[0].match(/title="([^"]*)"/)?.[1] ?? '');

test('a saved card\'s header has a compact Got it between the trash and the More menu', () => {
  const html = header();
  assert.deepEqual(buttonTitles(html), ['', 'Refresh with AI', 'Delete (D)', 'Remember (R)', 'More actions']);
  const gotIt = html.match(/<button[^>]*title="Remember \(R\)"[^>]*>[\s\S]*?<\/button>/)![0];
  assert.match(gotIt, /class="flex h-9 items-center gap-1 rounded-lg bg-emerald-500 px-3 text-sm font-bold text-white transition-colors hover:bg-emerald-600"/);
  assert.match(gotIt, /lucide-check[\s\S]*<\/svg> Got it<\/button>$/);
  assert.doesNotMatch(html, /Archived|Unarchive/);
});

test('an archived card\'s header reads Archived and offers Unarchive in Got it\'s place', () => {
  const html = header({ archived: true });
  assert.deepEqual(buttonTitles(html), ['', 'Refresh with AI', 'Delete (D)', 'Unarchive (A)', 'More actions']);
  assert.doesNotMatch(html, /Got it/);
  assert.match(html, /lucide-archive-restore[\s\S]*?<span class="text-xs font-bold">Unarchive<\/span><\/button>/);
  // The chip leads the second row, before the memory, whose bar takes the width left.
  const secondRow = html.slice(html.indexOf('<div class="px-4 pb-2">'));
  assert.match(secondRow, /^<div class="px-4 pb-2"><div class="flex items-center gap-2 text-xs"><span class="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0\.5 font-semibold text-slate-600"><svg[^>]*lucide-archive[^>]*>[\s\S]*?<\/svg> Archived<\/span>/);
  assert.match(secondRow, /flex-1 h-1\.5 bg-slate-200/);
});

test('an unsaved card offers Save only, and a header told no handler offers no Got it or Unarchive', () => {
  const unsaved = header({ isSaved: false, stats: null });
  assert.deepEqual(buttonTitles(unsaved), ['', 'Refresh with AI', '']);
  assert.match(unsaved, />Save<\/span><\/button>/);
  assert.doesNotMatch(unsaved, /Got it|Archived/);
  assert.doesNotMatch(header({ onRemember: undefined }), /Got it/);
  assert.doesNotMatch(header({ archived: true, onUnarchive: undefined }), /Unarchive/);
  assert.match(header({ archived: true, onUnarchive: undefined }), / Archived<\/span>/, 'the chip still says so');
});

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

interface CardOptions {
  sense?: string;
  /** Reviewed this many times (once by default); a card never reviewed is to review whatever its schedule says. */
  reviews?: number;
  due?: number;
  archived?: boolean;
}
const schedule = (id: string, type: StoredItem['type'], { reviews = 1, due = NOW + DAY }: CardOptions): SRSData => ({
  ...SRSAlgorithm.createNew(id, type, 0), totalReviews: reviews, nextReview: due, memoryStrength: reviews ? 40 : 0,
});
const word = (spelling: string, options: CardOptions = {}): StoredItem => {
  const id = `${spelling}:${options.sense ?? ''}`;
  const data = { id, word: spelling, sense: options.sense, examples: [] } as Partial<VocabCard> as VocabCard;
  return { type: 'vocab', data, savedAt: 1, isArchived: options.archived, srs: schedule(id, 'vocab', options) };
};
const phrase = (query: string, options: CardOptions = {}): StoredItem => ({
  type: 'phrase',
  data: { id: query, query, translation: '', grammar: '', visualKeyword: '', pronunciation: '', vocabs: [], timestamp: 1 },
  savedAt: 1,
  isArchived: options.archived,
  srs: schedule(query, 'phrase', options),
});
const group = (...items: StoredItem[]): ItemGroup => ({ title: items[0].data.id, items });

test('the words after each card left to review, counted from the end: archived and resting cards don\'t count', () => {
  const groups = [
    group(word('due', { due: NOW - DAY })),
    group(word('resting')),
    group(word('new', { reviews: 0, due: NOW + 5 * DAY })),
    group(word('archived due', { archived: true, due: NOW - DAY })),
    group(word('bank', { sense: 'river' }), word('bank', { sense: 'money', due: NOW })),
    group(phrase('on the fence', { archived: true, reviews: 0 }), phrase('on the fence', { due: NOW - 1 })),
  ];
  assert.deepEqual(buildToReviewFrom(groups, NOW), [4, 3, 3, 2, 2, 1, 0]);
  assert.deepEqual(buildToReviewFrom([], NOW), [0]);
  // A day on, the resting word is due as well.
  assert.deepEqual(buildToReviewFrom(groups, NOW + DAY), [5, 4, 3, 2, 2, 1, 0]);
});

test('the position line names the word\'s place, then the words after it left to review, or that it is archived', () => {
  assert.equal(cardPositionLine({ index: 11, total: 230, toReviewAfter: 5, archived: false }), 'Word 12 of 230 · 5 to review after this');
  assert.equal(cardPositionLine({ index: 229, total: 230, toReviewAfter: 0, archived: false }), 'Word 230 of 230');
  assert.equal(cardPositionLine({ index: 2, total: 18, toReviewAfter: 4, archived: true }), 'Word 3 of 18 · archived');
  assert.equal(cardPositionLine({ index: 0, total: 1, toReviewAfter: 0, archived: false }), null, 'a view of one word');
  assert.equal(cardPositionLine({ index: 0, total: 0, toReviewAfter: 0, archived: false }), null);
});

test('in one library at one clock, the Notebook header, its Due badges and the position line count the same words', () => {
  const library: StoredItem[] = [
    word('bank', { sense: 'money', due: NOW - DAY }), word('bank', { sense: 'river' }),
    word('run', { sense: 'move' }), word('run', { sense: 'manage', reviews: 0 }),
    word('saved just now', { reviews: 0, due: NOW + 60_000 }),
    word('due now', { due: NOW }),
    word('resting', { due: NOW + 3 * DAY }),
    word('soon', { due: NOW + 60_000 }),
    word('archived', { archived: true, due: NOW - DAY }),
    word('archived new', { archived: true, reviews: 0 }),
    { ...word('deleted', { due: NOW - DAY }), isDeleted: true },
    phrase('on the fence', { due: NOW - 2 * DAY }),
    phrase('break a leg', { reviews: 0 }),
    phrase('in the long run'),
  ];
  for (const clock of [NOW, NOW + 60_000, NOW + 4 * DAY]) {
    const list = buildNotebookList(library, null, 'familiarity', 'all', clock);
    const header = notebookStats(library, 'all', list.now).toReview;
    const badges = list.groups.filter(row => row.items.some(item => isNotebookDue(item, list.now))).length;
    // Opened on the list's first card: the words after it, and that card itself when it is to review.
    const fromFirst = buildToReviewFrom(list.groups, list.now);
    const firstIsDue = list.groups[0].items.some(item => isNotebookDue(item, list.now));
    const line = cardPositionLine({ index: 0, total: list.groups.length, toReviewAfter: fromFirst[1], archived: false });
    const lineCount = Number(line?.match(/· (\d+) to review after this$/)?.[1] ?? 0);
    assert.ok(header > 1, 'the fixture has words to review');
    assert.equal(badges, header, `badges at +${clock - NOW} ms`);
    assert.equal(lineCount + (firstIsDue ? 1 : 0), header, `the position line at +${clock - NOW} ms: ${line}`);
  }
});
