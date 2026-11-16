import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOfflineImageBundle } from '../src/offline-image-import.js';

const bundle = {
  version: 1,
  generatedAt: 1,
  model: 'krea/Krea-2-Turbo',
  entries: [{
    parentId: 'phrase-1',
    imageId: 'vocab-1',
    parentHash: 'a'.repeat(64),
    imageFile: 'images/vocab-1.webp',
    promptHash: 'b'.repeat(64),
  }],
};

test('offline image bundle validates ownership binding and safe paths', () => {
  assert.equal(validateOfflineImageBundle(bundle), null);
  assert.match(validateOfflineImageBundle({ ...bundle, entries: [{ ...bundle.entries[0], imageFile: '../dictprop.db' }] }) || '', /imageFile/);
  assert.match(validateOfflineImageBundle({ ...bundle, entries: [...bundle.entries, bundle.entries[0]] }) || '', /duplicates/);
  assert.match(validateOfflineImageBundle({ ...bundle, entries: [{ ...bundle.entries[0], promptHash: 'bad' }] }) || '', /promptHash/);
});

test('a bundle or entry that is not an object, a bad time or a bad hash each get their own refusal', () => {
  const withEntry = (changes: object) => validateOfflineImageBundle({ ...bundle, entries: [{ ...bundle.entries[0], ...changes }] });
  for (const value of [null, [bundle], 'bundle']) assert.equal(validateOfflineImageBundle(value), 'bundle must be an object');
  for (const generatedAt of [0, -1, Number.NaN, Infinity, '1']) {
    assert.equal(validateOfflineImageBundle({ ...bundle, generatedAt }), 'bundle generatedAt is invalid');
  }
  assert.equal(validateOfflineImageBundle({ ...bundle, entries: [[bundle.entries[0]]] }), 'entry 0 must be an object');
  for (const parentHash of ['A'.repeat(64), 'a'.repeat(63), 64]) assert.equal(withEntry({ parentHash }), 'entry 0 parentHash is invalid');
  assert.equal(withEntry({ promptHash: 'B'.repeat(64) }), 'entry 0 promptHash is invalid');
  assert.equal(withEntry({ promptHash: undefined }), null);
});
