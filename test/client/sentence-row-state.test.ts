import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SRSData } from '../../types.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import { getMasteryColors } from '../../components/mastery.tsx';
import { sentenceRowState } from '../../views/detail/sentenceRowState.ts';
import { SentenceActionsRow } from '../../views/detail/SentenceActionsRow.tsx';

// Sentence review's bottom row (views/detail/sentenceRowState.ts and SentenceActionsRow.tsx): it goes by the
// sentence's reviews, so a first listen that creates a catalog line's record changes nothing, and Got it keeps one
// size and its place at the right end in every state.

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
