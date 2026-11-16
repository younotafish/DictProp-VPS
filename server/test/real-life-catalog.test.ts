import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getAllRealLifeCatalogSentenceTexts } from '../src/real-life-catalog.js';
import { repoPath } from './support/paths.js';

test('Real Life catalog contains five substantial, stable collections', () => {
  const source = JSON.parse(readFileSync(repoPath('content/real-life-catalog.json'), 'utf8')) as {
    collections: Array<{ id: string; sections: Array<{ sentences: Array<{ text: string; focus: string }> }> }>;
  };
  assert.deepEqual(
    source.collections.map(collection =>
      [collection.id, collection.sections.reduce((count, section) => count + section.sentences.length, 0)]),
    [
      ['career-conversations', 234],
      ['daily-shopping', 252],
      ['executive-communication', 234],
      ['restaurant-conversations', 200],
      ['travel-conversations', 200],
    ],
  );
  const texts = getAllRealLifeCatalogSentenceTexts();
  assert.equal(texts.length, 1120);
  assert.equal(new Set(texts).size, 1120);
  // The server reads every line, in catalog order.
  assert.deepEqual(texts, source.collections.flatMap(collection =>
    collection.sections.flatMap(section => section.sentences.map(sentence => sentence.text))));
  assert.equal(source.collections[0].sections[0].sentences[0].focus, 'unplug');
  assert.match(texts[0], /unplug/);
});
