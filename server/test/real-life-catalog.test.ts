import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getRealLifeCatalogSentence,
  getRealLifeCatalogSentenceCount,
  getAllRealLifeCatalogSentenceTexts,
} from '../src/real-life-catalog.js';
import { repoPath } from './support/paths.js';

const firstSentenceId = 'career-conversations:rapport-and-small-talk:01';

test('Real Life catalog contains five substantial, stable collections', () => {
  const source = JSON.parse(readFileSync(repoPath('content/real-life-catalog.json'), 'utf8')) as {
    collections: Array<{ id: string; sections: Array<{ sentences: unknown[] }> }>;
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
  assert.equal(getRealLifeCatalogSentenceCount(), 1120);
  assert.equal(new Set(getAllRealLifeCatalogSentenceTexts()).size, 1120);
  const sentence = getRealLifeCatalogSentence(firstSentenceId);
  assert.equal(sentence?.focus, 'unplug');
  assert.match(sentence?.text || '', /unplug/);
  assert.equal(getRealLifeCatalogSentence('career-conversations:missing:01'), undefined);
});
