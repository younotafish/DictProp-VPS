import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstVisibleRowIndex, nextScrollAction, type ListScrollAction, type ListScrollInputs,
} from '../../services/notebook/listScroll.ts';

const browse: ListScrollInputs = { query: '', settled: true, sort: 'familiarity', filter: 'vocab', aiSubmitKey: 0 };
const at = (changes: Partial<ListScrollInputs>): ListScrollInputs => ({ ...browse, ...changes });
const action = (scroll: ListScrollAction['scroll'], anchor: ListScrollAction['anchor']): ListScrollAction => ({ scroll, anchor });

test('the first character typed over the browse list remembers its spot, and the results jump to the top once settled', () => {
  // The box changes at once; the list renders the search a moment later.
  const typed = at({ query: 'b', settled: false });
  assert.deepEqual(nextScrollAction(browse, typed, false), action(null, 'save'));
  const settled = at({ query: 'b', settled: true });
  assert.deepEqual(nextScrollAction(typed, settled, true), action('top', 'keep'));
  // Settled in the same step (a list that renders the search at once) still saves first, then jumps.
  assert.deepEqual(nextScrollAction(browse, settled, false), action('top', 'save'));
});

test('refining a search jumps to its new results; a re-render of the same results stays put', () => {
  const ba = at({ query: 'ba', settled: true });
  const typing = at({ query: 'ban', settled: false });
  assert.deepEqual(nextScrollAction(ba, typing, true), action(null, 'keep'));
  const ban = at({ query: 'ban', settled: true });
  assert.deepEqual(nextScrollAction(typing, ban, true), action('top', 'keep'));
  assert.deepEqual(nextScrollAction(ban, { ...ban }, true), action(null, 'keep'));
  // A query nothing contains settles when its fuzzy results land, a pause later.
  const fuzzyWait = at({ query: 'acommodate', settled: false });
  assert.deepEqual(nextScrollAction(ban, fuzzyWait, true), action(null, 'keep'));
  assert.deepEqual(nextScrollAction(fuzzyWait, at({ query: 'acommodate', settled: true }), true), action('top', 'keep'));
});

test('emptying the box returns to the remembered spot once the browse list is back, or stays put without one', () => {
  const ban = at({ query: 'ban', settled: true });
  const emptied = at({ query: '', settled: false });
  assert.deepEqual(nextScrollAction(ban, emptied, true), action(null, 'keep'));
  assert.deepEqual(nextScrollAction(emptied, browse, true), action('restore', 'drop'));
  assert.deepEqual(nextScrollAction(emptied, browse, false), action(null, 'drop'));
  assert.deepEqual(nextScrollAction(browse, { ...browse }, false), action(null, 'keep'));
});

test('typing again before the browse list came back keeps the first spot instead of saving the search’s', () => {
  const emptied = at({ query: '', settled: false });
  assert.deepEqual(nextScrollAction(emptied, at({ query: 'x', settled: false }), true), action(null, 'keep'));
});

test('a new sort or filter jumps to the top and forgets the spot, while browsing or searching', () => {
  for (const from of [browse, at({ query: 'ban', settled: true })]) {
    assert.deepEqual(nextScrollAction(from, { ...from, sort: 'alphabetical' }, true), action('top', 'drop'));
    assert.deepEqual(nextScrollAction(from, { ...from, filter: 'all' }, true), action('top', 'drop'));
  }
});

test('an AI lookup jumps to the top as it starts; a voice transcript also remembers the spot it was typed over', () => {
  const ban = at({ query: 'ban', settled: true });
  assert.deepEqual(nextScrollAction(ban, { ...ban, aiSubmitKey: 1 }, true), action('top', 'keep'));
  assert.deepEqual(nextScrollAction(browse, at({ query: 'gamut', settled: false, aiSubmitKey: 1 }), false), action('top', 'save'));
});

test('the first visible row is the first one whose bottom is below the header', () => {
  const rows = [
    { index: 12, bottom: 90 },
    { index: 13, bottom: 240 },
    { index: 11, bottom: -60 },
    { index: 14, bottom: 400 },
  ];
  assert.equal(firstVisibleRowIndex(rows, 120), 13);
  assert.equal(firstVisibleRowIndex(rows, 89), 12);
  assert.equal(firstVisibleRowIndex(rows, 90), 13, 'a row ending at the header is hidden');
  assert.equal(firstVisibleRowIndex(rows, 500), null);
  assert.equal(firstVisibleRowIndex([], 0), null);
  assert.equal(firstVisibleRowIndex([{ index: Number.NaN, bottom: 50 }, { index: 3, bottom: 60 }], 0), 3);
});
