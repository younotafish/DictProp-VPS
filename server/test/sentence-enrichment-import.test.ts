import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-sentence-enrichment-import-test-'));
process.env.DATA_DIR = DATA_DIR;

const { getSentenceEnrichmentForText, getSentenceEnrichmentImage, upsertSentenceEnrichment } = await import('../src/db.js');
const { sentenceLookupHash } = await import('../src/sentence-enrichment.js');

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const png = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
const analysis = (translation: string) => ({
  translation,
  americanEnglish: { status: 'shared' as const, explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph of a quiet street in the early morning, without text.',
});
const entry = (text: string, generatedAt: number, imageFile?: string) => {
  const lookupHash = sentenceLookupHash(text);
  return {
    id: `example-${lookupHash.slice(0, 40)}`, text, lookupHash, textHash: sha256(text),
    analysis: analysis(`译文：${text}`), generatedAt, ...(imageFile ? { imageFile } : {}),
  };
};

function runImport(manifest: string) {
  const { NODE_TEST_CONTEXT: _testContext, ...parentEnv } = process.env;
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/import-sentence-enrichments.ts', manifest], {
    cwd: serverDir,
    env: { ...parentEnv, DATA_DIR },
    encoding: 'utf8',
  });
  const lines = child.stdout.trim().split('\n');
  return { status: child.status, stderr: child.stderr, output: JSON.parse(lines[lines.length - 1] || 'null') };
}

test('a bad image is skipped and counted while the rest of the bundle imports', () => {
  const good = entry('The good image arrives with its analysis.', 200, 'images/good.png');
  const corrupt = entry('This image file is not an image at all.', 200, 'images/corrupt.png');
  const missing = entry('This image never made it into the bundle.', 200, 'images/missing.png');
  // A sentence that already has an image keeps it when the new one is bad.
  const kept = entry('An earlier import already stored this image.', 200, 'images/kept.png');
  upsertSentenceEnrichment({ entry: { ...kept, generatedAt: 100 }, image: png('earlier'), mimeType: 'image/png' });

  const dir = mkdtempSync(join(tmpdir(), 'dictprop-sentence-enrichment-bundle-'));
  mkdirSync(join(dir, 'images'));
  writeFileSync(join(dir, 'images', 'good.png'), png('good'));
  writeFileSync(join(dir, 'images', 'corrupt.png'), 'not an image');
  writeFileSync(join(dir, 'images', 'kept.png'), Buffer.alloc(0));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, generatedAt: 200, entries: [good, corrupt, missing, kept] }));

  const run = runImport(join(dir, 'manifest.json'));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.total, 4);
  assert.equal(run.output.inserted, 3);
  assert.equal(run.output.updated, 1);
  assert.equal(run.output.imagesSkipped, 3);
  assert.deepEqual(run.output.imageErrors.map((error: { id: string }) => error.id), [corrupt.id, missing.id, kept.id]);
  assert.deepEqual(run.output.imageErrors.map((error: { error: string }) => error.error), [
    'image format is invalid', 'image is unreadable (ENOENT)', 'image size is invalid',
  ]);

  for (const imported of [good, corrupt, missing, kept]) {
    assert.equal(getSentenceEnrichmentForText(imported.text)?.analysis.translation, imported.analysis.translation);
  }
  assert.deepEqual(getSentenceEnrichmentImage(good.lookupHash)?.data, png('good'));
  assert.equal(getSentenceEnrichmentImage(corrupt.lookupHash), null);
  assert.equal(getSentenceEnrichmentImage(missing.lookupHash), null);
  assert.deepEqual(getSentenceEnrichmentImage(kept.lookupHash)?.data, png('earlier'));
});

test('a bundle whose image path could leave it is still refused whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dictprop-sentence-enrichment-bundle-'));
  const escaping = { ...entry('This entry points outside its bundle.', 300), imageFile: 'images/../../outside.png' };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, generatedAt: 300, entries: [escaping] }));
  const run = runImport(join(dir, 'manifest.json'));
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /imageFile is invalid/);
  assert.equal(getSentenceEnrichmentForText(escaping.text), null);
});
