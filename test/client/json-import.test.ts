import assert from 'node:assert/strict';
import test from 'node:test';
import { importErrorMessage, parseImportText } from '../../services/notebook/jsonImport.ts';

test('one card or an array of them is accepted, keeping the items with a word or a full item id', () => {
  assert.deepEqual(parseImportText(' {"word":"ubiquitous","chinese":"无处不在的"} '), {
    items: [{ word: 'ubiquitous', chinese: '无处不在的' }], error: null,
  });
  const full = { data: { id: 'x', word: 'a' }, type: 'vocab' };
  assert.deepEqual(parseImportText(JSON.stringify([{ word: 'apple' }, full, { chinese: '苹果' }, null, 7, 'pear'])), {
    items: [{ word: 'apple' }, full], error: null,
  });
});

test('JSON with nothing to import, or no JSON at all, says why', () => {
  assert.deepEqual(parseImportText('[{"chinese":"苹果"}, {"data":{}}]'), {
    items: null, error: 'No valid items found. Each item needs at least a "word" field.',
  });
  const invalid = parseImportText('[{"word":');
  assert.equal(invalid.items, null);
  assert.match(invalid.error ?? '', /^Invalid JSON: /);
});

test("an import failure reads as a sentence: the server's JSON error, a short message, or a generic line", () => {
  assert.equal(importErrorMessage(new TypeError('Failed to fetch')), "Couldn't reach the server. Check your connection and try again.");
  assert.equal(importErrorMessage(new Error('{"error":"Import is limited to 5000 items"}')), 'Import is limited to 5000 items');
  assert.equal(importErrorMessage(new Error('Import failed: 413')), 'Import failed: 413');
  assert.equal(importErrorMessage(new Error('<html><body>502 Bad Gateway</body></html>')), 'Import failed. Please try again.');
  assert.equal(importErrorMessage(new Error('x'.repeat(301))), 'Import failed. Please try again.');
  assert.equal(importErrorMessage('not an error'), 'Import failed. Please try again.');
});
