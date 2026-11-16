import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  getAllEssayCatalogSentenceTexts,
  getPrivateEssayCatalog,
  validatePrivateEssayCatalog,
  type RawEssayCatalog,
} from '../src/essay-catalog.js';
import { repoPath } from './support/paths.js';

test('Essay catalog starts with five complete, stable public-domain texts', () => {
  // The server refuses to load an essay whose sentences don't add up to its sentenceCount.
  const source = JSON.parse(readFileSync(repoPath('content/essay-catalog.json'), 'utf8')) as RawEssayCatalog;
  assert.deepEqual(
    source.essays.map(essay => [essay.id, essay.sentenceCount]),
    [
      ['self-reliance', 504],
      ['corn-pone-opinions', 97],
      ['spiritual-strivings', 102],
      ['why-i-wrote-the-yellow-wallpaper', 17],
      ['how-it-feels-to-be-colored-me', 105],
    ],
  );
  assert.equal(source.essays[0].title, 'Self-Reliance');
  // The test runner's DATA_DIR holds no private catalog, so only the static texts count.
  const texts = getAllEssayCatalogSentenceTexts();
  assert.equal(texts.length, 825);
  assert.match(texts[0], /eminent painter/);
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

test('a private catalog in DATA_DIR joins the static texts, and its removal takes it away again', () => {
  const dataDir = process.env.DATA_DIR!;
  const path = join(dataDir, 'private-essay-catalog.json');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify(privateCatalog));
  const privateText = 'Attention becomes deliberate when routine stops feeling invisible.';
  try {
    const texts = getAllEssayCatalogSentenceTexts();
    assert.equal(texts.length, 826);
    assert.match(texts[0], /eminent painter/);
    assert.equal(texts.at(-1), privateText);
    assert.deepEqual(getPrivateEssayCatalog().essays.map(essay => essay.id), ['modern-test-essay']);
  } finally {
    rmSync(path, { force: true });
  }
  assert.equal(getAllEssayCatalogSentenceTexts().length, 825);
  assert.ok(!getAllEssayCatalogSentenceTexts().includes(privateText));
  assert.deepEqual(getPrivateEssayCatalog().essays, []);
});
