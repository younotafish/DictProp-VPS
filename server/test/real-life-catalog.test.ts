import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getAllRealLifeCatalogSentenceTexts } from '../src/real-life-catalog.js';
import { repoPath } from './support/paths.js';

const source = JSON.parse(readFileSync(repoPath('content/real-life-catalog.json'), 'utf8')) as {
  collections: Array<{
    id: string;
    sections: Array<{ id: string; sentences: Array<{ id: string; text: string; focus: string }> }>;
  }>;
};

test('Real Life catalog contains five substantial, stable collections', () => {
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
});

test('every Real Life line carries an id of its own, so its progress stays with it', () => {
  const textById = new Map<string, string>();
  for (const collection of source.collections) {
    for (const section of collection.sections) {
      const ids = section.sentences.map(sentence => sentence.id);
      assert.ok(ids.every(id => typeof id === 'string' && id.trim() !== ''), `${collection.id}/${section.id} has a line without an id`);
      assert.equal(new Set(ids).size, ids.length, `${collection.id}/${section.id} repeats an id`);
      for (const sentence of section.sentences) textById.set(`${collection.id}:${section.id}:${sentence.id}`, sentence.text);
    }
  }
  assert.equal(textById.size, 1120);
  // Users' progress records are kept under these ids (real-life-sentence:<id>): an id never moves to another line.
  assert.match(textById.get('career-conversations:rapport-and-small-talk:01') ?? '', /^How was your weekend\? Did you get a chance to unplug\?$/);
  assert.match(textById.get('travel-conversations:delays-cancellations-and-connections:07') ?? '', /^Please confirm whether my checked bag will follow the rebook/);
});
