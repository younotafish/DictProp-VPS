import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefusedReviewsDialog } from '../../components/RefusedReviewsDialog.tsx';
import { recordRefusedReview } from '../../services/refusedReviews.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// components/RefusedReviewsDialog.tsx, rendered on the server, over a refusal log in localStorage.
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

test('the list shows a sentence as it reads, also one an older build recorded with its {{ }} and [[ ]] markers', () => {
  // Builds before the markers were stripped at record time logged the sentence raw, and the log keeps entries until Clear all.
  recordRefusedReview('u1', { itemId: 's1', word: 'She {{ran}} to the [[station]].', reviewedAt: 1, reason: 'The card isn’t on the server' }, undefined, 10);
  recordRefusedReview('u1', { itemId: 'w1', word: 'gamut', reviewedAt: 2, reason: 'The card isn’t on the server' }, undefined, 20);
  const html = renderToStaticMarkup(createElement(RefusedReviewsDialog, { userId: 'u1', onClose: () => {} }));
  const listed = [...html.matchAll(/<span class="min-w-0 break-words font-semibold text-slate-800">([^<]*)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(listed, ['gamut', 'She ran to the station.'], 'newest first');
  assert.doesNotMatch(html, /\{\{|\}\}|\[\[|\]\]/);
});
