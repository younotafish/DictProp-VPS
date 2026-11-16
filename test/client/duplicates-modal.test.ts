import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DuplicatesModal } from '../../components/DuplicatesModal.tsx';
import { findDuplicateClusterViews } from '../../services/duplicateClusters.ts';
import type { StoredItem } from '../../types.ts';

// components/DuplicatesModal.tsx: what the dialog says merging does, and when it cautions about removed cards.

const card = (word: string, forms: string[], id: string, { sense, reviews = 0 }: { sense?: string; reviews?: number } = {}): StoredItem => ({
  type: 'vocab',
  data: { id, word, forms, sense, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: reviews, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});

// ran and run list each other, so their cluster starts ticked; find and found don't, so theirs starts unticked.
const RAN = ['run'];
const RUN = ['runs', 'running', 'ran'];
const render = (items: StoredItem[]) => renderToStaticMarkup(createElement(DuplicatesModal, {
  clusters: findDuplicateClusterViews(items), onClose: () => {}, onMerge: () => {},
}));
const caution = (html: string) => html.match(/Merging removes [^<]*/)?.[0] ?? null;

test('the dialog says the cards are relabeled to the headword and keep their own review progress', () => {
  const html = render([card('ran', RAN, 'ran'), card('run', RUN, 'run')]);
  assert.ok(html.includes(
    'Pick the headword to keep: the other forms’ cards are relabeled to it, and every form is kept. Review progress isn’t merged: '
    + 'each card keeps its own, and a sense saved twice keeps only its more-reviewed card.',
  ));
  assert.doesNotMatch(html, /review progress is merged/);
});

test('with nothing to remove among the ticked merges, the dialog cautions about nothing', () => {
  // Unlabeled cards never collide, so ran/run only relabels; find/found would remove a card, but starts unticked.
  const html = render([
    card('ran', RAN, 'ran'),
    card('run', RUN, 'run'),
    card('find', ['finds', 'finding', 'found'], 'find', { sense: 'discover' }),
    card('found', ['founds', 'founding', 'founded'], 'found', { sense: 'discover' }),
  ]);
  assert.match(html, /relabels 1 card, removes 0/);
  assert.equal(caution(html), null);
});

test('a ticked merge that removes duplicates of one sense says how many, and to close other tabs and devices first', () => {
  const one = render([card('ran', RAN, 'ran', { sense: 'move' }), card('run', RUN, 'run', { sense: 'Move', reviews: 3 })]);
  assert.match(one, /relabels 0 cards, removes 1/);
  assert.equal(caution(one),
    'Merging removes 1 duplicate card of the same sense. Close other open tabs and devices first, so sync doesn’t bring it back.');

  const two = render([
    card('ran', RAN, 'ran-move', { sense: 'move' }),
    card('ran', RAN, 'ran-manage', { sense: 'manage' }),
    card('run', RUN, 'run-move', { sense: 'move', reviews: 3 }),
    card('run', RUN, 'run-manage', { sense: 'manage', reviews: 3 }),
  ]);
  assert.match(two, /removes 2/);
  assert.equal(caution(two),
    'Merging removes 2 duplicate cards of the same sense. Close other open tabs and devices first, so sync doesn’t bring them back.');
});
