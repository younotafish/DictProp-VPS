import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogStudyItems,
  indexCatalogProgress,
  summarizeCatalogProgress,
} from '../../services/catalogProgress.ts';
import {
  catalogProgressItemId,
  catalogProgressKind,
  isCatalogProgressItem,
  type CatalogKind,
} from '../../services/catalogProgressIdentity.ts';
import { SRSAlgorithm } from '../../services/srsAlgorithm.ts';
import type { SentenceData, StoredItem } from '../../types.ts';

const NOW = 2_000_000;

function record(id: string, data: Partial<SentenceData> = {}, overrides: Partial<StoredItem> = {}): StoredItem {
  return {
    type: 'sentence',
    data: { id, text: 'A line.', sourceWord: 'line', ...data },
    savedAt: 1,
    srs: SRSAlgorithm.createNew(id, 'sentence'),
    ...overrides,
  };
}

const realLife = (lineId: string, data: Partial<SentenceData> = {}) => record(`real-life-sentence:${lineId}`, {
  catalogKind: 'real-life', catalogSentenceId: lineId, catalogCollectionId: 'career-conversations', ...data,
});
const essay = (lineId: string, data: Partial<SentenceData> = {}) => record(`essay-sentence:${lineId}`, {
  catalogKind: 'essay', catalogSentenceId: lineId, catalogCollectionId: 'self-reliance', ...data,
});

test('progress ids are the catalog prefix followed by the line id', () => {
  assert.equal(catalogProgressItemId('real-life', 'career:intro:01'), 'real-life-sentence:career:intro:01');
  assert.equal(catalogProgressItemId('essay', 'self-reliance-1'), 'essay-sentence:self-reliance-1');
});

test('a record keeps catalog progress only when its id, line and collection agree', () => {
  const cases: [string, StoredItem, CatalogKind | null][] = [
    ['a Real Life record', realLife('c:s:01'), 'real-life'],
    // The first Real Life records were saved before catalogKind existed.
    ['a Real Life record without catalogKind', realLife('c:s:01', { catalogKind: undefined }), 'real-life'],
    ['a Real Life id whose record says essay', realLife('c:s:01', { catalogKind: 'essay' }), 'real-life'],
    ['an essay record', essay('e-1'), 'essay'],
    ['an essay id without catalogKind', essay('e-1', { catalogKind: undefined }), null],
    ['an essay id whose record says real-life', essay('e-1', { catalogKind: 'real-life' }), null],
    ['an id that names another line', realLife('c:s:01', { catalogSentenceId: 'c:s:02' }), null],
    ['a record without its line', essay('e-1', { catalogSentenceId: '' }), null],
    ['a record without its collection', realLife('c:s:01', { catalogCollectionId: undefined }), null],
    ['a line saved to the Sentences tab', record('sentence-1', { catalogSentenceId: 'c:s:01', catalogCollectionId: 'c' }), null],
    ['a word card with a catalog-like id', { ...realLife('c:s:01'), type: 'vocab' }, null],
  ];
  for (const [name, item, kind] of cases) {
    assert.equal(catalogProgressKind(item), kind, name);
    assert.equal(isCatalogProgressItem(item), kind !== null, name);
  }
});

test('an index holds one catalog\'s live records by line id', () => {
  const live = realLife('c:s:01');
  const deleted = { ...realLife('c:s:02'), isDeleted: true };
  const items = [live, deleted, essay('e-1'), record('sentence-1')];

  const index = indexCatalogProgress(items, 'real-life');
  assert.deepEqual([...index.keys()], ['c:s:01']);
  assert.equal(index.get('c:s:01'), live);
  assert.deepEqual([...indexCatalogProgress(items, 'essay').keys()], ['e-1']);
});

test('a summary reads each sentence\'s record, counting a sentence without one as unreviewed', () => {
  const due = realLife('c:s:01');
  due.srs = { ...due.srs, totalReviews: 2, nextReview: NOW - 1, memoryStrength: 50 };
  const memorized = realLife('c:s:02');
  memorized.srs = { ...memorized.srs, totalReviews: 4, nextReview: NOW + 1, memoryStrength: 90 };
  const index = indexCatalogProgress([due, memorized], 'real-life');

  const summary = summarizeCatalogProgress([{ id: 'c:s:01' }, { id: 'c:s:02' }, { id: 'c:s:03' }, { id: 'c:s:04' }], index, NOW);
  assert.deepEqual(summary, { total: 4, reviewed: 2, unreviewed: 2, due: 1, memorized: 1, toReview: 3, masteryScore: 35 });
});

test('a run opens each line\'s stored record, and a new one for a line never stored', () => {
  const stored = essay('e-2');
  const index = indexCatalogProgress([stored], 'essay');
  const created: string[] = [];
  const items = catalogStudyItems([{ id: 'e-1' }, { id: 'e-2' }], index, sentence => {
    created.push(sentence.id);
    return essay(sentence.id);
  });
  assert.deepEqual(created, ['e-1']);
  assert.equal(items[1], stored);
  assert.equal(items[0].data.id, 'essay-sentence:e-1');
});
