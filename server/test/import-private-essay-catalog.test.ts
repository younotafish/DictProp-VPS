import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { lastJsonLine, runScript } from './support/library.js';

const DATA_DIR = process.env.DATA_DIR!;
const destination = join(DATA_DIR, 'private-essay-catalog.json');

const catalog = {
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
    description: 'A private catalog import fixture.',
    level: 'C1–C2',
    accent: 'indigo',
    collection: 'modern',
    themes: ['attention', 'voice'],
    modernityNote: 'Contemporary American prose.',
    sourceLabel: 'Authorized study source',
    sourceUrl: 'https://example.com/essay',
    publicDomainNote: 'Owner-private study copy.',
    wordCount: 16,
    readingMinutes: 1,
    sentenceCount: 2,
    paragraphs: [{
      kind: 'body',
      id: 'modern-test-essay:p001',
      sentences: [
        { id: 'modern-test-essay:p001:s01', text: 'Attention becomes deliberate when routine stops.', focus: 'deliberate' },
        { id: 'modern-test-essay:p001:s02', text: 'A voice carries what a summary cannot.', focus: 'voice' },
      ],
    }],
  }],
};

function input(name: string, value: string): string {
  const path = join(process.env.TMPDIR!, name);
  writeFileSync(path, value);
  return path;
}

test('the essay import validates the catalog and replaces the private copy whole, readable by its owner only', () => {
  const run = runScript('import-private-essay-catalog', [input('catalog.json', JSON.stringify(catalog))]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(lastJsonLine(run.stdout), { imported: true, file: 'private-essay-catalog.json', essays: 1, sentences: 2 });
  assert.equal(readFileSync(destination, 'utf8'), `${JSON.stringify(catalog, null, 2)}\n`);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(DATA_DIR).filter(name => name.endsWith('.tmp')), []);
});

test('a catalog that fails validation, or is empty, leaves the private copy as it was', () => {
  const before = readFileSync(destination, 'utf8');
  const classic = structuredClone(catalog);
  classic.essays[0].collection = 'classic';
  const refused = runScript('import-private-essay-catalog', [input('classic.json', JSON.stringify(classic))]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /invalid essay: modern-test-essay/);

  const empty = runScript('import-private-essay-catalog', [input('empty.json', '')]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /Private essay catalog size is invalid/);

  const missing = runScript('import-private-essay-catalog');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Usage: import-private-essay-catalog <catalog\.json>/);

  assert.equal(readFileSync(destination, 'utf8'), before);
  assert.equal(existsSync(join(DATA_DIR, `.private-essay-catalog-${process.pid}.tmp`)), false);
});
