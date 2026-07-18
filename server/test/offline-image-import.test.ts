import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOfflineImageBundle } from '../src/offline-image-import.js';

const bundle = {
  version: 1,
  generatedAt: 1,
  model: 'krea/Krea-2-Turbo',
  entries: [{ parentId: 'phrase-1', imageId: 'vocab-1', parentHash: 'a'.repeat(64), imageFile: 'images/vocab-1.webp' }],
};

test('offline image bundle validates ownership binding and safe paths', () => {
  assert.equal(validateOfflineImageBundle(bundle), null);
  assert.match(validateOfflineImageBundle({ ...bundle, entries: [{ ...bundle.entries[0], imageFile: '../dictprop.db' }] }) || '', /imageFile/);
  assert.match(validateOfflineImageBundle({ ...bundle, entries: [...bundle.entries, bundle.entries[0]] }) || '', /duplicates/);
});
