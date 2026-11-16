import assert from 'node:assert/strict';
import test from 'node:test';
import { checkStoredItem, checkStoredItemBatch } from '../src/validation.js';
import { srs } from './support/fixtures.js';

const vocab = (id: string) => ({ type: 'vocab', data: { id, word: 'lucid' }, srs: srs(id, 'vocab'), savedAt: 1 });

test('an accepted item comes back as itself, and a refused one as the reason', () => {
  const item = vocab('lucid-1');
  const checked = checkStoredItem(item);
  assert.ok('item' in checked && checked.item === item);
  assert.deepEqual(checkStoredItem({ ...item, type: 'card' }), { error: 'item.type is invalid' });
  assert.deepEqual(checkStoredItem(null), { error: 'item must be an object' });
});

test('a batch is accepted whole or refused with the reason for its first bad item', () => {
  const items = [vocab('lucid-1'), vocab('lucid-2')];
  const checked = checkStoredItemBatch(items, 2);
  assert.ok('items' in checked && checked.items === items);
  assert.deepEqual(checkStoredItemBatch({}, 2), { error: 'Expected array of items' });
  assert.deepEqual(checkStoredItemBatch([], 2), { error: 'At least one item is required' });
  assert.deepEqual(checkStoredItemBatch([...items, vocab('lucid-3')], 2), { error: 'At most 2 items are allowed per request' });
  assert.deepEqual(
    checkStoredItemBatch([items[0], { ...items[1], srs: null }, { type: 'card' }], 3),
    { error: 'Invalid item at index 1: item.srs must be an object' },
  );
});
