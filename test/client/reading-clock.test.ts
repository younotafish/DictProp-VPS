import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceData, SRSData, StoredItem } from '../../types.ts';
import { SentenceRow } from '../../views/SentencesView.tsx';

const NOW = Date.UTC(2026, 10, 15, 12);
const DAY = 86_400_000;
const noop = () => {};

/** A saved sentence whose schedule is a new one's, saved at `savedAt`, with `srs` laid over it. */
const sentence = (id: string, srs: Partial<SRSData> = {}, savedAt = NOW - DAY): StoredItem & { type: 'sentence'; data: SentenceData } => ({
  type: 'sentence',
  data: { id, text: `The ${id} sentence.`, sourceWord: id },
  savedAt,
  srs: { ...SRSAlgorithm.createNew(id, 'sentence', savedAt), ...srs },
});

const renderRow = (item: ReturnType<typeof sentence>, toReview: boolean, dueLabel?: string) => renderToStaticMarkup(createElement(SentenceRow, {
  item, toReview, dueLabel, confirmingDelete: false, onOpen: noop, onUpdateSRS: async () => true, onDelete: noop,
  onConfirmDelete: noop, onSearch: noop,
}));
const bar = (markup: string) => markup.match(/<div class="absolute left-0 top-3 bottom-3 w-1 rounded-full ([^"]*)"><\/div>/)?.[1];
const REVIEWED = 'title="Mark as reviewed"';

test('a Sentences row never reviewed has the slate bar, whatever its seed strength; a reviewed row\'s bar follows its strength', () => {
  const fresh = renderRow(sentence('fresh'), true);
  assert.equal(bar(fresh), 'bg-slate-300');
  assert.ok(fresh.includes('hover:shadow-sm border-orange-200 bg-orange-50/30"'), 'to review: the orange row');
  assert.ok(fresh.includes(REVIEWED));

  // Display strength from stability: 1 day -> 12, 12 days -> 46, 47 days -> 70.
  const reviewed = (stability: number) => sentence(`s${stability}`, { totalReviews: 3, stability, nextReview: NOW + 3 * DAY });
  assert.equal(bar(renderRow(reviewed(1), false, 'in 3d')), 'bg-red-400');
  assert.equal(bar(renderRow(reviewed(12), false, 'in 3d')), 'bg-amber-400');
  const strong = renderRow(reviewed(47), false, 'in 3d');
  assert.equal(bar(strong), 'bg-emerald-400');
  assert.ok(strong.includes('hover:shadow-sm border-slate-100 bg-white"'));
  assert.ok(strong.includes('<span class="text-xs text-slate-400">in 3d</span>'));
  assert.ok(!strong.includes(REVIEWED));
});
