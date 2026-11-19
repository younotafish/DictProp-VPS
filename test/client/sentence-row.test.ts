import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { indexRealLifeProgress } from '../../services/realLifeProgress.ts';
import { REAL_LIFE_COLLECTIONS } from '../../services/realLifeCatalog.ts';
import { needsReview } from '../../services/sentenceReviewState.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceData, SRSData, StoredItem } from '../../types.ts';
import { HighlightedSentence } from '../../components/HighlightedSentence.tsx';
import { restingLabelFor, SentenceRow, SentencesView } from '../../views/SentencesView.tsx';
import { RealLifeCollectionScreen, RealLifeSentenceRow } from '../../views/reading/RealLifeCollectionScreen.tsx';

// List rows render on the server, but Virtuoso draws none of a list's rows there, so the rows render on their own.

const NOW = Date.UTC(2026, 10, 16, 12);
const DAY = 86_400_000;
const noop = () => {};

const never: StoredItem & { type: 'sentence'; data: SentenceData } = {
  type: 'sentence',
  data: { id: 'never', text: 'She {{broke the ice}} with a joke.', sourceWord: 'break the ice' },
  savedAt: NOW,
  srs: SRSAlgorithm.createNew('never', 'sentence', NOW),
};

type RowProps = Parameters<typeof SentenceRow>[0];
const rowProps = (overrides: Partial<RowProps> = {}): RowProps => ({
  item: never, toReview: true, confirmingDelete: false, onOpen: noop, onUpdateSRS: async () => true, onDelete: noop,
  onConfirmDelete: noop, onSearch: noop, ...overrides,
});

interface Props {
  role?: string; title?: string; studiedItemInteractive?: boolean; children?: unknown;
  onKeyDown?: (event: unknown) => void; onClick?: (event: unknown) => void;
}

/** A memoized row's elements, depth first: its inner function uses no hooks, so calling it returns them. */
function elements<P>(row: unknown, props: P): ReactElement<Props>[] {
  const out: ReactElement<Props>[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    out.push(node as ReactElement<Props>);
    walk((node as ReactElement<Props>).props.children);
  };
  walk((row as { type: (p: P) => ReactElement }).type(props));
  return out;
}

/** Clicks an element as a pointer does: `detail` is the click's count, 2 for a double click's second click, 0 for a key. */
const clickWith = (element: ReactElement<Props>, detail: number) => {
  let stopped = false;
  element.props.onClick!({ detail, stopPropagation: () => { stopped = true; } });
  return stopped;
};

test('a never-reviewed Sentences row is orange with Reviewed and the slate bar', () => {
  const markup = renderToStaticMarkup(createElement(SentenceRow, rowProps()));
  assert.ok(markup.includes('<div class="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-slate-300"></div>'));
  assert.ok(markup.includes('border-orange-200 bg-orange-50/30"'));
  assert.ok(markup.includes('title="Mark as reviewed"'));
  assert.ok(markup.includes('role="button" tabindex="0"'), 'the row is a keyboard stop');
});

test('Space or Enter on a focused Sentences row opens it once; a held key or a key on its buttons does not', () => {
  const opened: string[] = [];
  const row = elements(SentenceRow, rowProps({ onOpen: item => opened.push(item.data.id) }))
    .find(element => element.props.role === 'button')!;
  const target = {};
  const press = (key: string, overrides: object = {}) => {
    const calls: string[] = [];
    row.props.onKeyDown!({
      key, repeat: false, target, currentTarget: target, ...overrides,
      preventDefault: () => calls.push('preventDefault'), stopPropagation: () => calls.push('stopPropagation'),
    });
    return calls;
  };
  assert.deepEqual(press('Enter'), ['preventDefault', 'stopPropagation']);
  assert.deepEqual(press(' '), ['preventDefault', 'stopPropagation']);
  assert.deepEqual(opened, ['never', 'never']);

  assert.deepEqual(press('Enter', { repeat: true }), []);
  assert.deepEqual(press(' ', { target: {} }), [], 'Space on Reviewed or Delete is the button\'s own');
  assert.deepEqual(press('ArrowDown'), []);
  assert.deepEqual(opened, ['never', 'never']);
});

test('the review chips say which one is selected, and the search boxes have names, on Sentences and in Real Life', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const sentences = renderToStaticMarkup(createElement(SentencesView, {
    items: [never], onUpdateSRS: async () => true, onDelete: noop, onSearch: noop, onScroll: noop, onOpenSentence: noop,
  }));
  assert.ok(sentences.includes('aria-label="Search saved sentences"'));
  const sentenceChips = [...sentences.matchAll(/aria-pressed="(true|false)" title="([^"]*)" class="[^"]*">([^<]+)/g)]
    .map(([, pressed, title, label]) => `${label} (${title}):${pressed}`);
  assert.deepEqual(sentenceChips, [
    'All (All sentences):true', 'New (Never reviewed yet):false', 'Due (Reviewed before and due again now):false',
    'Memorized (Reviewed — not due right now):false',
  ]);

  const collection = REAL_LIFE_COLLECTIONS[0];
  const realLife = renderToStaticMarkup(createElement(RealLifeCollectionScreen, {
    collection, progressIndex: indexRealLifeProgress([]), onClose: noop, onOpenSentence: noop,
    onUpdateSRS: async () => true, isSentenceSaved: () => false, onScroll: noop,
  }));
  assert.ok(realLife.includes(`aria-label="Search ${collection.title}"`));
  const pressed = [...realLife.matchAll(/aria-pressed="(true|false)"[^>]*>([^<]+)/g)]
    .map(([, state, label]) => `${label.trim().replaceAll('&amp;', '&')}:${state}`);
  // The four review chips, then All and one chip per theme.
  // A line never reviewed is New there, as in the stats strip above them and on the tiles.
  assert.deepEqual(pressed.slice(0, 4), ['All:true', 'New:false', 'Due:false', 'Memorized:false']);
  assert.deepEqual(pressed.slice(4), [
    `All ${collection.sentences.length}:true`,
    ...collection.sections.map(section => `${section.title}:false`),
  ]);
});

// Saved words for the rows below: the studied phrase and 'joke'.
const savedCard = (word: string) => ({ type: 'vocab', savedAt: 0, data: { id: word, word } }) as unknown as StoredItem;
const findSaved = (term: string) => {
  const bare = term.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  return bare === 'broke the ice' || bare === 'joke' ? savedCard(bare) : null;
};

test('in a Sentences row the studied phrase is plain emphasis even when saved, so a tap on it opens the sentence', () => {
  const props = rowProps({ findSaved, onOpenCard: noop });
  const markup = renderToStaticMarkup(createElement(SentenceRow, props));
  assert.ok(markup.includes('<span class="text-indigo-700 font-semibold bg-indigo-50 rounded px-0.5" data-word-offset="4">broke the ice</span>'));
  assert.match(markup, /data-word-offset="\d+" role="button" tabindex="0">joke\.<\/span>/, 'a dotted saved word still opens its card');
  assert.equal(elements(SentenceRow, props).find(element => element.type === HighlightedSentence)!.props.studiedItemInteractive, false);
});

test('Reviewed on a Sentences row records one review per press: a double click\'s second click records nothing', () => {
  const reviewed: string[] = [];
  const button = elements(SentenceRow, rowProps({ onUpdateSRS: async id => { reviewed.push(id); return true; } }))
    .find(element => element.props.title === 'Mark as reviewed')!;
  assert.equal(clickWith(button, 1), true, 'the press never reaches the row');
  assert.equal(clickWith(button, 2), true, 'nor does the second click of a double click');
  assert.equal(clickWith(button, 0), true);
  assert.deepEqual(reviewed, ['never', 'never'], 'the first click and the key press review; the second click does not');
});

test('a Real Life row: the studied phrase is plain, and Reviewed ignores a double click\'s second click', () => {
  const line = REAL_LIFE_COLLECTIONS[0].sentences[0];
  const reviewed: string[] = [];
  const props = {
    sentence: line, softClass: 'bg-indigo-50 text-indigo-700', saved: false, state: 'due' as const, masteryPercent: 0,
    onOpen: noop, onMarkReviewed: (sentence: typeof line) => reviewed.push(sentence.id), findSaved, onOpenCard: noop,
  };
  const tree = elements(RealLifeSentenceRow, props);
  assert.equal(tree.find(element => element.type === HighlightedSentence)!.props.studiedItemInteractive, false);
  const button = tree.find(element => element.props.title === 'Mark as reviewed')!;
  clickWith(button, 1);
  clickWith(button, 2);
  assert.deepEqual(reviewed, [line.id]);
});

/** A saved sentence Today owns (`membership`), reviewed twice, its classic schedule a day overdue. */
const owned = (id: string, membership: Partial<SRSData>): typeof never => ({
  ...never,
  data: { ...never.data, id, text: `The ${id} sentence.` },
  srs: {
    ...SRSAlgorithm.createNew(id, 'sentence', NOW - 3 * DAY), totalReviews: 2, nextReview: NOW - DAY,
    practiceChangedAt: NOW - 2 * DAY, ...membership,
  },
});

test('a sentence Today owns rests on the Sentences tab: a white row with no Reviewed, saying where it stands in Today', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const practicing = owned('practicing', { practiceSince: NOW - 2 * DAY });
  const sayable = owned('sayable', { sayableAt: NOW - 2 * DAY });
  assert.equal(restingLabelFor(practicing.srs, NOW), 'Practicing in Today');
  assert.equal(restingLabelFor(sayable.srs, NOW), 'Can say it');
  // Kept passive, it is back on its schedule, and the row says when that comes due.
  const { practiceSince: _left, ...kept } = practicing.srs;
  assert.equal(restingLabelFor({ ...kept, nextReview: NOW + 3 * DAY }, NOW), 'in 3d');

  const row = renderToStaticMarkup(createElement(SentenceRow, rowProps({
    item: practicing, toReview: needsReview(practicing.srs, NOW), restingLabel: restingLabelFor(practicing.srs, NOW),
  })));
  assert.ok(row.includes('hover:shadow-sm border-slate-100 bg-white"'), 'not the orange row');
  assert.ok(!row.includes('title="Mark as reviewed"'));
  assert.ok(row.includes('<span class="text-xs text-slate-400">Practicing in Today</span>'), 'never "due"');

  // The header and the chips count by the same rule: the new sentence is to review, the two Today owns are memorized.
  const view = renderToStaticMarkup(createElement(SentencesView, {
    items: [never, practicing, sayable], onUpdateSRS: async () => true, onDelete: noop, onSearch: noop, onScroll: noop,
    onOpenSentence: noop,
  }));
  assert.match(view, />1 to review</);
  const chips = [...view.matchAll(/aria-pressed="(?:true|false)" title="[^"]*" class="[^"]*">([^<]+)(?:<span class="[^"]*">(\d+)<\/span>)?<\/button>/g)]
    .map(([, label, count]) => `${label} ${count ?? 0}`);
  assert.deepEqual(chips, ['All 3', 'New 1', 'Due 0', 'Memorized 2']);
});
