import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAllEssayCatalogSentenceTexts,
  getEssayCatalogSentence,
  getEssayCatalogSentenceCount,
  getEssayCatalogSummaries,
  validatePrivateEssayCatalog,
  type RawEssayCatalog,
} from '../src/essay-catalog.js';

test('Essay catalog starts with five complete, stable public-domain texts', () => {
  const summaries = getEssayCatalogSummaries();
  assert.deepEqual(
    summaries.slice(0, 5).map(summary => [summary.id, summary.sentenceCount]),
    [
      ['self-reliance', 504],
      ['corn-pone-opinions', 97],
      ['spiritual-strivings', 102],
      ['why-i-wrote-the-yellow-wallpaper', 17],
      ['how-it-feels-to-be-colored-me', 105],
    ],
  );
  assert.ok(getEssayCatalogSentenceCount() >= 825);
  assert.equal(getAllEssayCatalogSentenceTexts().length, getEssayCatalogSentenceCount());
  const first = getEssayCatalogSentence('self-reliance:p001:s01');
  assert.equal(first?.essayTitle, 'Self-Reliance');
  assert.match(first?.text || '', /eminent painter/);
  assert.equal(getEssayCatalogSentence('self-reliance:missing'), undefined);
});

const privateCatalog: RawEssayCatalog = {
  version: 1,
  generatedAt: '2026-08-10T00:00:00.000Z',
  editorialNote: 'Private modern essay test.',
  essays: [{
    id: 'modern-test-essay',
    title: 'A Modern Test Essay',
    author: 'Test Author',
    year: 2005,
    publication: 'Test publication',
    eyebrow: 'Voice & attention',
    description: 'A private catalog validation fixture.',
    level: 'C1–C2',
    accent: 'indigo',
    collection: 'modern',
    themes: ['attention', 'voice'],
    modernityNote: 'Contemporary American prose.',
    sourceLabel: 'Authorized study source',
    sourceUrl: 'https://example.com/essay',
    publicDomainNote: 'Owner-private study copy.',
    rightsNote: 'Stored privately for personal study.',
    wordCount: 8,
    readingMinutes: 1,
    sentenceCount: 1,
    paragraphs: [{
      kind: 'body',
      id: 'modern-test-essay:p001',
      sentences: [{
        id: 'modern-test-essay:p001:s01',
        text: 'Attention becomes deliberate when routine stops feeling invisible.',
        focus: 'deliberate',
      }],
    }],
  }],
};

test('private essay catalog validation accepts modern texts and protects static ids', () => {
  assert.doesNotThrow(() => validatePrivateEssayCatalog(privateCatalog));

  const wrongCollection = structuredClone(privateCatalog);
  wrongCollection.essays[0].collection = 'classic';
  assert.throws(() => validatePrivateEssayCatalog(wrongCollection), /invalid essay/);

  const duplicate = structuredClone(privateCatalog);
  duplicate.essays[0].id = 'self-reliance';
  duplicate.essays[0].paragraphs = [{
    kind: 'body',
    id: 'self-reliance:p999',
    sentences: [{
      id: 'self-reliance:p999:s01',
      text: 'A duplicate catalog should never displace the historical collection.',
      focus: 'historical',
    }],
  }];
  assert.throws(() => validatePrivateEssayCatalog(duplicate), /invalid essay/);
});

test('private essay catalog accepts book-sized collections up to the safety limit', () => {
  const expanded = structuredClone(privateCatalog);
  expanded.essays = Array.from({ length: 21 }, (_, index) => {
    const essay = structuredClone(privateCatalog.essays[0]);
    essay.id = `modern-test-essay-${index + 1}`;
    essay.paragraphs[0] = {
      kind: 'body',
      id: `${essay.id}:p001`,
      sentences: [{
        id: `${essay.id}:p001:s01`,
        text: `Attention becomes deliberate when routine number ${index + 1} stops feeling invisible.`,
        focus: 'deliberate',
      }],
    };
    return essay;
  });
  assert.doesNotThrow(() => validatePrivateEssayCatalog(expanded));

  const oversized = structuredClone(expanded);
  oversized.essays = Array.from({ length: 101 }, (_, index) => {
    const essay = structuredClone(expanded.essays[index % expanded.essays.length]);
    essay.id = `oversized-test-essay-${index + 1}`;
    essay.paragraphs[0] = {
      kind: 'body',
      id: `${essay.id}:p001`,
      sentences: [{
        id: `${essay.id}:p001:s01`,
        text: `Attention becomes deliberate when oversized routine ${index + 1} stops feeling invisible.`,
        focus: 'deliberate',
      }],
    };
    return essay;
  });
  assert.throws(() => validatePrivateEssayCatalog(oversized), /too many essays/);
});
