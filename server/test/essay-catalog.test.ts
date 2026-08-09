import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAllEssayCatalogSentenceTexts,
  getEssayCatalogSentence,
  getEssayCatalogSentenceCount,
  getEssayCatalogSummaries,
} from '../src/essay-catalog.js';

test('Essay catalog contains five complete, stable public-domain texts', () => {
  const summaries = getEssayCatalogSummaries();
  assert.deepEqual(
    summaries.map(summary => [summary.id, summary.sentenceCount]),
    [
      ['self-reliance', 504],
      ['corn-pone-opinions', 97],
      ['spiritual-strivings', 102],
      ['why-i-wrote-the-yellow-wallpaper', 17],
      ['how-it-feels-to-be-colored-me', 105],
    ],
  );
  assert.equal(getEssayCatalogSentenceCount(), 825);
  assert.equal(getAllEssayCatalogSentenceTexts().length, 825);
  const first = getEssayCatalogSentence('self-reliance:p001:s01');
  assert.equal(first?.essayTitle, 'Self-Reliance');
  assert.match(first?.text || '', /eminent painter/);
  assert.equal(getEssayCatalogSentence('self-reliance:missing'), undefined);
});
