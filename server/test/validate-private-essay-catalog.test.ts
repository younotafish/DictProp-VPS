import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_PRIVATE_ESSAY_CATALOG_BYTES } from '../src/essay-catalog.js';
import { REPO_ROOT, repoPath } from './support/paths.js';
import { lastJsonLine, spawnScript } from './support/scripts.js';

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
    description: 'A private catalog validation fixture.',
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

const validate = (...args: string[]) => spawnScript('validate-private-essay-catalog', args);

test('a catalog the importer accepts passes with its essay and sentence counts, and no database is opened', () => {
  const run = validate(input('catalog.json', JSON.stringify(catalog)));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(lastJsonLine(run.stdout), { valid: true, essays: 1, sentences: 2 });
  assert.equal(existsSync(process.env.DATA_DIR!), false);
});

test("a catalog the importer would refuse fails with the importer's reason", () => {
  const classic = structuredClone(catalog);
  classic.essays[0].collection = 'classic';
  const { modernityNote: _modernityNote, ...withoutNote } = catalog.essays[0];
  // A private essay may not take the id of an essay in the checked-in catalog.
  const reserved = structuredClone(catalog);
  reserved.essays[0].id = 'self-reliance';
  const refusals: Array<[string, string, RegExp]> = [
    ['classic.json', JSON.stringify(classic), /invalid essay: modern-test-essay/],
    ['no-note.json', JSON.stringify({ ...catalog, essays: [withoutNote] }), /invalid essay: modern-test-essay/],
    ['reserved.json', JSON.stringify(reserved), /invalid essay: self-reliance/],
    ['no-essays.json', JSON.stringify({ ...catalog, essays: [] }), /Essay catalog must contain at least one essay/],
    ['empty.json', '', /Private essay catalog size is invalid/],
    ['truncated.json', JSON.stringify(catalog).slice(0, 100), /SyntaxError/],
  ];
  for (const [name, contents, reason] of refusals) {
    const run = validate(input(name, contents));
    assert.equal(run.status, 1, name);
    assert.match(run.stderr, reason, name);
    assert.equal(run.stdout, '', name);
  }
});

test('a catalog file larger than the importer takes fails, however valid the catalog in it', () => {
  // JSON allows trailing whitespace, so the padding keeps the catalog valid and leaves only the size to decide.
  const padded = (bytes: number) => {
    const text = JSON.stringify(catalog);
    return text + ' '.repeat(bytes - Buffer.byteLength(text));
  };
  const atLimit = validate(input('at-limit.json', padded(MAX_PRIVATE_ESSAY_CATALOG_BYTES)));
  assert.equal(atLimit.status, 0, atLimit.stderr);
  assert.deepEqual(lastJsonLine(atLimit.stdout), { valid: true, essays: 1, sentences: 2 });

  const over = validate(input('over-limit.json', padded(MAX_PRIVATE_ESSAY_CATALOG_BYTES + 1)));
  assert.equal(over.status, 1);
  assert.match(over.stderr, /Private essay catalog size is invalid/);
  assert.equal(over.stdout, '');
});

test('the validator names its argument when it is given none', () => {
  const run = validate();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Usage: validate-private-essay-catalog <catalog\.json>/);
});

test('the essay publisher checks the catalog with the validator before it creates a release', () => {
  const root = mkdtempSync(join(process.env.TMPDIR!, 'essay-publisher-'));
  const ghLog = join(root, 'gh.log');
  // The stand-in GitHub CLI records each call and refuses it, so a publication stops at its first release.
  writeFileSync(join(root, 'gh'), `#!/bin/sh\necho "$*" >> '${ghLog}'\nexit 1\n`, { mode: 0o700 });
  writeFileSync(join(root, 'key'), 'test-key\n');
  const publish = (catalogPath: string) => spawnSync('bash', [
    repoPath('scripts', 'offline', 'publish-private-essay-catalog.sh'), catalogPath, 'test-sha',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GH_BIN: join(root, 'gh'), SENTENCE_BRIDGE_KEY_FILE: join(root, 'key') },
  });

  // The publisher's own checks used to let this one through: the id belongs to a checked-in essay.
  const reserved = structuredClone(catalog);
  reserved.essays[0].id = 'self-reliance';
  const refused = publish(input('publish-reserved.json', JSON.stringify(reserved)));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /invalid essay: self-reliance/);
  assert.equal(existsSync(ghLog), false);

  const checked = publish(input('publish-modern.json', JSON.stringify(catalog)));
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout.split('\n')[0]), { valid: true, essays: 1, sentences: 2 });
  assert.match(readFileSync(ghLog, 'utf8'), /^release create private-essays-\d{8}T\d{6}Z --repo /);
});
