import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { SRSData, StoredItem } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { updateAfterRating } from '../../services/fsrsScheduler.ts';
import { getMasteryColors } from '../../components/mastery.tsx';
import { lessonReviewPill, memorizedCount, sentenceRowState } from '../../views/detail/sentenceRowState.ts';
import { resolveSentenceUnderReview } from '../../views/detail/sentenceUnderReview.ts';
import { SentenceActionsRow } from '../../views/detail/SentenceActionsRow.tsx';
import { SentenceHeaderRow } from '../../views/detail/SentenceHeaderRow.tsx';
import { readRepoFile } from '../support/paths.ts';

// Sentence review's bottom row (views/detail/sentenceRowState.ts and SentenceActionsRow.tsx): it goes by the
// sentence's reviews, so a first listen that creates a catalog line's record changes nothing, and Got it keeps one
// size and its place at the right end in every state. And the run's counters: the header's 'to review' pill and the
// row's memorized count.

test('the row shows the memory and Reset only after a first review, Delete only on the learner\'s own saved sentences', () => {
  const row = (catalog: boolean, preview: boolean, totalReviews: number) => sentenceRowState({ catalog, preview, totalReviews });
  // A catalog line before any record, with a record a listen created, and once reviewed.
  assert.deepEqual(row(true, true, 0), { showStats: false, showReset: false, showDelete: false, primary: 'got-it' });
  assert.deepEqual(row(true, false, 0), { showStats: false, showReset: false, showDelete: false, primary: 'got-it' });
  assert.deepEqual(row(true, false, 1), { showStats: true, showReset: true, showDelete: false, primary: 'got-it' });
  // A saved sentence never reviewed, and reviewed.
  assert.deepEqual(row(false, false, 0), { showStats: false, showReset: false, showDelete: true, primary: 'got-it' });
  assert.deepEqual(row(false, false, 3), { showStats: true, showReset: true, showDelete: true, primary: 'got-it' });
  // An unsaved example opened from a word card.
  assert.deepEqual(row(false, true, 0), { showStats: false, showReset: false, showDelete: false, primary: 'save-sentence' });
});

test('a catalog line\'s first listen changes nothing in the row; its first review adds only the memory and Reset', () => {
  const beforeAnyRecord = sentenceRowState({ catalog: true, preview: true, totalReviews: 0 });
  const afterAListen = sentenceRowState({ catalog: true, preview: false, totalReviews: 0 });
  const afterAReview = sentenceRowState({ catalog: true, preview: false, totalReviews: 1 });
  assert.deepEqual(afterAListen, beforeAnyRecord);
  assert.deepEqual({ ...afterAReview, showStats: false, showReset: false }, beforeAnyRecord);
  for (const preview of [true, false]) {
    for (const totalReviews of [0, 1, 9]) {
      assert.equal(sentenceRowState({ catalog: true, preview, totalReviews }).showDelete, false, 'never Delete in a catalog lesson');
    }
  }
});

type RowProps = ComponentProps<typeof SentenceActionsRow>;
const schedule = (reviews: number): SRSData => {
  const srs = SRSAlgorithm.createNew('s1', 'sentence', 0);
  return reviews === 0 ? srs : { ...srs, totalReviews: reviews, memoryStrength: 40, nextReview: Date.now() + 86_400_000 };
};
/** The row as sentence review renders it for a sentence with `reviews` reviews (see SentenceReviewView). */
const rowFor = (kind: 'catalog' | 'saved' | 'example', preview: boolean, reviews: number, extra: Partial<RowProps> = {}) => {
  const srs = schedule(reviews);
  const state = sentenceRowState({ catalog: kind === 'catalog', preview, totalReviews: reviews });
  const mastery = state.showStats ? SRSAlgorithm.getMasteryLevel(srs) : null;
  return renderToStaticMarkup(createElement(SentenceActionsRow, {
    srs, mastery, masteryColors: mastery ? getMasteryColors(mastery.color) : null, memorizedCount: 2, preview,
    catalog: kind === 'catalog', catalogKind: kind === 'catalog' ? 'essay' : undefined, onRemember: () => {},
    onSaveSentence: () => {}, onReset: state.showReset ? () => {} : undefined, onDelete: () => {}, ...extra,
  }));
};

/** The right end's buttons, in order: their titles. */
const rightButtons = (html: string) => {
  const right = html.slice(html.indexOf('<div class="ml-auto'));
  return [...right.matchAll(/<button[^>]*title="([^"]*)"/g)].map(match => match[1]);
};
/** The classes of the button whose label is `label`. */
const buttonClasses = (html: string, label: string) => {
  const button = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g)]
    .find(match => match[0].includes(`</svg> ${label}</button>`));
  assert.ok(button, `a ${label} button`);
  return button[1];
};
const GOT_IT = '-my-1 flex min-h-9 items-center gap-1 rounded-lg px-4 text-sm font-bold text-white transition-colors bg-emerald-500 hover:bg-emerald-600';

test('a never-reviewed catalog line shows only the compact Got it, before and after a listen creates its record', () => {
  for (const preview of [true, false]) {
    const html = rowFor('catalog', preview, 0);
    assert.doesNotMatch(html, /New|×|lucide-flame/, 'no memory on the left');
    assert.deepEqual(rightButtons(html), [preview ? 'Remember in this essay (R)' : 'Remember (R)']);
    assert.equal(buttonClasses(html, 'Got it'), GOT_IT);
  }
});

test('once reviewed, the memory and Reset appear to the left and Got it keeps its size at the right end', () => {
  const catalog = rowFor('catalog', false, 1);
  assert.match(catalog, /1×/);
  assert.deepEqual(rightButtons(catalog), ['Reset memory (Shift+R)', 'Remember (R)']);
  assert.equal(buttonClasses(catalog, 'Got it'), GOT_IT);

  const saved = rowFor('saved', false, 3);
  assert.deepEqual(rightButtons(saved), ['Reset memory (Shift+R)', 'Delete sentence (D)', 'Remember (R)']);
  assert.equal(buttonClasses(saved, 'Got it'), GOT_IT);

  const savedNeverReviewed = rowFor('saved', false, 0);
  assert.deepEqual(rightButtons(savedNeverReviewed), ['Delete sentence (D)', 'Remember (R)'], 'nothing to reset yet');
  assert.doesNotMatch(savedNeverReviewed, /0×/);
});

test('an unsaved example offers Save sentence at the right end, at Got it\'s size, and no Got it', () => {
  const html = rowFor('example', true, 0);
  assert.deepEqual(rightButtons(html), ['Save sentence for review']);
  assert.equal(
    buttonClasses(html, 'Save sentence'),
    '-my-1 flex min-h-9 items-center gap-1 rounded-lg px-4 text-sm font-bold text-white transition-colors bg-indigo-600 hover:bg-indigo-700',
  );
  assert.equal(rightButtons(rowFor('example', true, 0, { onSaveSentence: undefined })).length, 0, 'nothing without a way to save');
});

const NOW = Date.UTC(2026, 10, 16, 9);
const DAY = 86_400_000;
/** A sentence of the run: never reviewed, or reviewed with its next review `dueIn` from NOW. */
const line = (id: string, review?: { dueIn: number; strength?: number }): StoredItem => {
  const srs = SRSAlgorithm.createNew(id, 'sentence', 0);
  return {
    type: 'sentence',
    data: { id, text: `Line ${id}.`, sourceWord: 'line' },
    savedAt: 1,
    srs: review ? { ...srs, totalReviews: 2, nextReview: NOW + review.dueIn, memoryStrength: review.strength ?? 50 } : srs,
  };
};

test('the pill counts the run\'s sentences never reviewed or due now, and reads All reviewed at none', () => {
  const run = [
    line('new-1'), line('new-2'),
    line('due', { dueIn: -DAY }), line('due-now', { dueIn: 0 }),
    line('resting', { dueIn: DAY, strength: 20 }), line('strong', { dueIn: 30 * DAY, strength: 95 }),
  ];
  assert.deepEqual(lessonReviewPill(run, NOW), { count: 4, label: '4 to review', tone: 'amber' });
  assert.deepEqual(lessonReviewPill([run[4], run[5]], NOW), { count: 0, label: 'All reviewed', tone: 'emerald' });
  assert.deepEqual(lessonReviewPill([], NOW), { count: 0, label: 'All reviewed', tone: 'emerald' });
  // The next day the resting sentence is due again.
  assert.equal(lessonReviewPill(run, NOW + DAY).count, 5);
});

test('a twelve-sentence run counts down to All reviewed as each one is remembered', () => {
  let run = Array.from({ length: 12 }, (_, index) => line(`s${index}`));
  const counts: string[] = [lessonReviewPill(run, NOW).label];
  for (let index = 0; index < run.length; index++) {
    run = run.map((item, at) => at === index ? line(item.data.id, { dueIn: DAY }) : item);
    counts.push(lessonReviewPill(run, NOW).label);
  }
  assert.deepEqual(counts, [...Array.from({ length: 12 }, (_, index) => `${12 - index} to review`), 'All reviewed']);
});

test('the memorized count is the run\'s sentences reviewed and not due, whatever their strength', () => {
  const run = [
    line('new'), line('due', { dueIn: -1, strength: 90 }),
    line('weak but resting', { dueIn: DAY, strength: 10 }), line('strong and resting', { dueIn: DAY, strength: 95 }),
  ];
  assert.equal(memorizedCount(run, NOW), 2);
  assert.equal(memorizedCount(run, NOW + 2 * DAY), 0);
});

// Today's v3 loop left membership on some sentences' schedules, which a Got it keeps: the lesson reads none of it.

test('a run\'s sentences carrying membership from Today\'s v3 loop count by their dates, so overdue ones are to review', () => {
  // What a v3 set left: practice, Can say it, or kept passive (practiceChangedAt alone).
  const carrying = (id: string, dueIn: number, membership: Partial<SRSData>): StoredItem => {
    const item = line(id, { dueIn });
    return { ...item, srs: { ...item.srs, practiceChangedAt: NOW - 2 * DAY, ...membership } };
  };
  const run = [
    line('new'),
    carrying('practicing', -DAY, { practiceSince: NOW - 2 * DAY }),
    carrying('sayable', -DAY, { sayableAt: NOW - 2 * DAY }),
    carrying('passive', DAY, {}),
  ];
  assert.deepEqual(lessonReviewPill(run, NOW), { count: 3, label: '3 to review', tone: 'amber' });
  assert.equal(memorizedCount(run, NOW), 1);
  // Once the passive one's date has passed too, the whole run is to review.
  assert.deepEqual(lessonReviewPill(run, NOW + 2 * DAY), { count: 4, label: '4 to review', tone: 'amber' });
  assert.equal(memorizedCount(run, NOW + 2 * DAY), 0);
});

test('a sentence a v3 set marked Can say it comes back after its date: its lesson counts it to review and its row says due', t => {
  // A triage Easy, as a set's Can say it recorded it.
  const marked = updateAfterRating(SRSAlgorithm.createNew('s1', 'sentence', NOW - DAY), 'easy', NOW, 'triage');
  assert.ok(marked.sayableAt !== undefined, 'marked as one you can say');
  const later = marked.nextReview + DAY;
  t.mock.method(Date, 'now', () => later);

  const run = [{ ...line('s1'), srs: marked }];
  assert.deepEqual(lessonReviewPill(run, later), { count: 1, label: '1 to review', tone: 'amber' });
  const mastery = SRSAlgorithm.getMasteryLevel(marked);
  const row = renderToStaticMarkup(createElement(SentenceActionsRow, {
    srs: marked, mastery, masteryColors: getMasteryColors(mastery.color), memorizedCount: memorizedCount(run, later),
    preview: false, catalog: false, catalogKind: undefined, onRemember: () => {}, onReset: () => {}, onDelete: () => {},
  }));
  assert.match(row, /aria-label="0 memorized in this list"/);
  assert.match(row, /0<\/span><span class="text-slate-500 whitespace-nowrap">due<\/span><div class="ml-auto/);
});

test('the lesson\'s row has no practice pill and names the next review, whatever membership a v3 set left', t => {
  t.mock.method(Date, 'now', () => NOW);
  const carrying = (nextReview: number, membership: Partial<SRSData>): SRSData => ({
    ...schedule(3), nextReview, practiceChangedAt: NOW - 30 * DAY, ...membership,
  });
  for (const membership of [{ practiceSince: NOW - 30 * DAY }, { sayableAt: NOW - 30 * DAY }, {}]) {
    const overdue = rowFor('saved', false, 3, { srs: carrying(NOW - 14 * DAY, membership) });
    const resting = rowFor('saved', false, 3, { srs: carrying(NOW + 3 * DAY, membership) });
    // After the memorized count, on a phone too.
    assert.match(overdue, /2<\/span><span class="text-slate-500 whitespace-nowrap">due<\/span><div class="ml-auto/);
    assert.match(resting, /2<\/span><span class="text-slate-500 whitespace-nowrap">3d<\/span><div class="ml-auto/);
    for (const html of [overdue, resting]) {
      // Reset, Delete and Got it, at its size, at the right end: nothing comes between Delete and Got it.
      assert.deepEqual(rightButtons(html), ['Reset memory (Shift+R)', 'Delete sentence (D)', 'Remember (R)']);
      assert.equal(buttonClasses(html, 'Got it'), GOT_IT);
      assert.doesNotMatch(html, /practic|can say it/i);
    }
  }
});

test('the memorized count says what it counts, and the header shows the pill in its tone', () => {
  const html = rowFor('saved', false, 3, { memorizedCount: 7 });
  assert.match(html, /role="img" aria-label="7 memorized in this list" title="7 memorized in this list">/);

  const header = (reviewPill: Parameters<typeof SentenceHeaderRow>[0]['reviewPill']) => renderToStaticMarkup(createElement(SentenceHeaderRow, {
    autoPlaying: false, exitLabel: 'Essays', onExit: () => {}, onOpenAnalysis: () => {}, loadingLesson: false, position: 1, total: 12,
    reviewPill,
  }));
  assert.match(header(lessonReviewPill([line('a'), line('b')], NOW)), /<span class="text-\[11px\] font-semibold text-amber-600 bg-amber-50 px-2 py-0\.5 rounded-full">2 to review<\/span>/);
  assert.match(header(lessonReviewPill([], NOW)), /<span class="text-\[11px\] font-semibold text-emerald-600 bg-emerald-50 px-2 py-0\.5 rounded-full">All reviewed<\/span>/);
  assert.doesNotMatch(header(null), /to review|All reviewed/, 'no pill in an unsaved example\'s preview');
  assert.doesNotMatch(header(lessonReviewPill([line('a')], NOW)), / due</);
});

/** The source of the `name` attribute's expression on the `component` element that SentenceReviewView renders. */
const reviewViewAttribute = (component: string, name: string): string | undefined => {
  const file = ts.createSourceFile(
    'SentenceReviewView.tsx', readRepoFile('views/detail/SentenceReviewView.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === component) {
      const attribute = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText() === name);
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
        found = attribute.initializer.expression?.getText();
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

test('an example opened under a study answer shows its memory after Save sentence and Got it, but no ✓ count, as it shows no pill', () => {
  // Study's example keeps the unsaved preview in its run after Save sentence, while the screen shows the saved copy.
  const preview = line('sentence-preview:5');
  const saved: StoredItem = {
    ...preview,
    data: { ...preview.data, id: 's5' },
    srs: { ...SRSAlgorithm.createNew('s5', 'sentence', 0), totalReviews: 1, nextReview: NOW + DAY, memoryStrength: 40 },
  };
  const shown = resolveSentenceUnderReview(preview, undefined, [saved], () => saved, false);
  assert.equal(shown.examplePreview, true);
  const row = sentenceRowState({ catalog: false, preview: shown.isSentencePreview, totalReviews: shown.currentSentence?.srs.totalReviews ?? 0 });
  assert.equal(row.showStats, true, 'Got it shows the memory');
  assert.equal(memorizedCount([preview], NOW), 0, 'the run would count the sentence just remembered as not memorized');

  // Sentence review hands the row no count there, as it hands the header no pill.
  assert.equal(reviewViewAttribute('SentenceHeaderRow', 'reviewPill'), 'examplePreview ? null : sentenceReviewPill');
  assert.equal(reviewViewAttribute('SentenceActionsRow', 'memorizedCount'), 'examplePreview ? null : sentenceMemorizedCount');
  const html = rowFor('saved', false, 1, { memorizedCount: null });
  assert.match(html, /1×/, 'the memory shows');
  assert.doesNotMatch(html, /memorized in this list/, 'without the count');
});
