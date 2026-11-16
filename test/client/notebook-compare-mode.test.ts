import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_COMPARE_WORDS } from '../../server/src/shared/query-mode.ts';
import { CompareBanner, canSelectForCompare } from '../../views/notebook/CompareMode.tsx';
import { NotebookHeader } from '../../views/notebook/NotebookHeader.tsx';

// views/notebook/CompareMode.tsx: how many words the Notebook's compare mode takes, and how it says so.

test('compare mode ticks up to MAX_COMPARE_WORDS words, as the word card\'s picker and /api/compare take', () => {
  assert.equal(canSelectForCompare(['run', 'jog', 'sprint'], 'dash'), true, 'a fourth word');
  const oneShort = Array.from({ length: MAX_COMPARE_WORDS - 1 }, (_, i) => `word ${i}`);
  assert.equal(canSelectForCompare(oneShort, 'last'), true);
  const full = [...oneShort, 'last'];
  assert.equal(canSelectForCompare(full, 'one more'), false);
  // A ticked word can always be unticked.
  assert.equal(canSelectForCompare(full, 'last'), true);
});

test('the banner and the compare button\'s title give the same range', () => {
  const banner = renderToStaticMarkup(createElement(CompareBanner, { selectedCount: 2, onExit: () => {} }));
  assert.match(banner, new RegExp(`>Select 2–${MAX_COMPARE_WORDS} words to compare<`));
  const noop = () => {};
  const header = renderToStaticMarkup(createElement(NotebookHeader, {
    headerRef: null, savedCount: 3, reviewedToday: 0, toReviewCount: 0, offline: false, toolsMenu: null, empty: false,
    compareMode: false, onToggleCompare: noop, filterMode: 'all', onCycleFilter: noop, sortMode: 'familiarity',
    onCycleSort: noop, user: { id: 'u1', email: 'me@example.com', displayName: null, photoUrl: null, isAdmin: false },
    onSignOut: async () => false, onViewRefusedReviews: noop, children: null,
  }));
  assert.ok(header.includes(`title="Compare words — select 2–${MAX_COMPARE_WORDS} to compare"`));
});
