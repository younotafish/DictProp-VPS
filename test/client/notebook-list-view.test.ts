import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_NOTEBOOK_LIST_VIEW, readNotebookListView, writeNotebookListView,
} from '../../services/notebook/listView.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

const KEY = 'notebook_view_v1';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(initial)) storage.setItem(key, value);
  return storage;
};

test('the sort and filter read back as they were written, under one device key', () => {
  const storage = memoryStorage();
  writeNotebookListView({ sort: 'alphabetical', filter: 'phrase' }, storage);
  assert.deepEqual([storage.length, storage.key(0)], [1, KEY]);
  assert.deepEqual(readNotebookListView(storage), { sort: 'alphabetical', filter: 'phrase' });
  writeNotebookListView({ sort: 'familiarity', filter: 'all' }, storage);
  assert.deepEqual(readNotebookListView(storage), { sort: 'familiarity', filter: 'all' });
});

test('nothing kept, or a damaged value, reads as review priority and words only', () => {
  assert.deepEqual(DEFAULT_NOTEBOOK_LIST_VIEW, { sort: 'familiarity', filter: 'vocab' });
  for (const raw of [undefined, '', '{', 'null', '"alphabetical"', '42', '[]']) {
    const storage = memoryStorage(raw === undefined ? {} : { [KEY]: raw });
    assert.deepEqual(readNotebookListView(storage), DEFAULT_NOTEBOOK_LIST_VIEW, String(raw));
  }
});

test('an unknown sort or filter falls back on its own, keeping the other field', () => {
  const read = (value: unknown) => readNotebookListView(memoryStorage({ [KEY]: JSON.stringify(value) }));
  assert.deepEqual(read({ sort: 'alphabetical', filter: 'sentence' }), { sort: 'alphabetical', filter: 'vocab' });
  assert.deepEqual(read({ sort: 'newest', filter: 'phrase' }), { sort: 'familiarity', filter: 'phrase' });
  assert.deepEqual(read({ filter: 'all' }), { sort: 'familiarity', filter: 'all' });
  assert.deepEqual(read({ sort: ['alphabetical'], filter: { all: true } }), DEFAULT_NOTEBOOK_LIST_VIEW);
});

test('the January keys 882be2f stopped reading are left alone', () => {
  const storage = memoryStorage({ notebook_sort_mode: 'alphabetical', notebook_filter_mode: 'phrase' });
  assert.deepEqual(readNotebookListView(storage), DEFAULT_NOTEBOOK_LIST_VIEW);
});

test('without storage, or with storage that throws, the defaults read and writing does nothing', () => {
  assert.deepEqual(readNotebookListView(null), DEFAULT_NOTEBOOK_LIST_VIEW);
  assert.doesNotThrow(() => writeNotebookListView({ sort: 'alphabetical', filter: 'all' }, null));
  // Node has no localStorage, as a browser that blocks it has none to give.
  assert.deepEqual(readNotebookListView(), DEFAULT_NOTEBOOK_LIST_VIEW);
  assert.doesNotThrow(() => writeNotebookListView({ sort: 'alphabetical', filter: 'all' }));
  const throwing = {
    getItem: () => { throw new DOMException('denied', 'SecurityError'); },
    setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
  };
  assert.deepEqual(readNotebookListView(throwing), DEFAULT_NOTEBOOK_LIST_VIEW);
  assert.doesNotThrow(() => writeNotebookListView({ sort: 'alphabetical', filter: 'all' }, throwing));
});
