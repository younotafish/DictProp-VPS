import assert from 'node:assert/strict';
import test from 'node:test';
import { advancedVocabContentHash } from '../src/local-enrichment-markers.js';
import { checkStoredItem, checkStoredItemBatch, validateStoredItem } from '../src/validation.js';
import { completeVocab, srs } from './support/fixtures.js';

const vocab = (id: string) => ({ type: 'vocab', data: { id, word: 'lucid' }, srs: srs(id, 'vocab'), savedAt: 1 });

const withAdvancedEnrichment = (data: Record<string, unknown>) => ({
  ...data,
  advancedEnrichment: {
    version: 1,
    provider: 'codex-harness',
    model: 'gpt-5.6-sol',
    generatedAt: 1,
    contentHash: advancedVocabContentHash(data),
  },
});

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

test("a schedule's practice membership is absent, or each field a finite time at or after 0, one state at a time, with its change time", () => {
  const item = vocab('lucid-practice');
  const withSrs = (fields: Record<string, unknown>) => ({ ...item, srs: { ...item.srs, ...fields } });
  assert.equal(validateStoredItem(withSrs({ practiceSince: 5, practiceChangedAt: 5 })), null);
  assert.equal(validateStoredItem(withSrs({ sayableAt: 0, practiceChangedAt: 0 })), null);
  assert.equal(validateStoredItem(withSrs({ practiceChangedAt: 7 })), null, 'a change time alone is harmless');
  for (const field of ['practiceSince', 'sayableAt', 'practiceChangedAt']) {
    for (const invalid of [-1, Infinity, NaN, '5', null]) {
      assert.equal(
        validateStoredItem(withSrs({ [field]: invalid, practiceChangedAt: field === 'practiceChangedAt' ? invalid : 1 })),
        'item.srs practice membership is invalid', `${field} ${invalid}`,
      );
    }
  }
  for (const incoherent of [{ practiceSince: 5, sayableAt: 6, practiceChangedAt: 6 }, { practiceSince: 5 }, { sayableAt: 5 }]) {
    assert.equal(validateStoredItem(withSrs(incoherent)), 'item.srs practice membership is invalid', JSON.stringify(incoherent));
  }
});

test('production imports accept Codex and Claude advanced-enrichment markers', () => {
  const wordSrs = srs('word', 'vocab');
  const enriched = withAdvancedEnrichment(completeVocab);
  for (const [provider, model] of [['codex-harness', 'gpt-5.6-sol'], ['claude-code', 'claude-opus-5-5']]) {
    const data = { ...enriched, advancedEnrichment: { ...enriched.advancedEnrichment, provider, model } };
    assert.equal(validateStoredItem({ type: 'vocab', data, srs: wordSrs, savedAt: 1 }), null);
    assert.equal(validateStoredItem({
      type: 'phrase', data: { id: 'word', query: 'a word', vocabs: [data] }, srs: { ...wordSrs, type: 'phrase' }, savedAt: 1,
    }), null);
  }
  assert.equal(validateStoredItem({
    type: 'vocab',
    data: { ...enriched, advancedEnrichment: { ...enriched.advancedEnrichment, provider: 'remote-api' } },
    srs: wordSrs,
    savedAt: 1,
  }), 'vocab advancedEnrichment is invalid');
});
