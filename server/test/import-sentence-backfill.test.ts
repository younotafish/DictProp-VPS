import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { png, sha256 } from './support/fs.js';
import { addItemImage, createOwner, OWNER_EMAIL, saveItem } from './support/library.js';
import { runServerScript } from './support/scripts.js';

const DATA_DIR = process.env.DATA_DIR!;
const { getItemById, getItemImage } = await import('../src/db.js');

const owner = createOwner();
const stored = (id: string) => getItemById(id, owner.id, false) as { data: Record<string, unknown>; serverRevision?: number };
const dataUri = (seed: string) => `data:image/png;base64,${png(seed).toString('base64')}`;
const analysis = (translation: string) => ({
  translation,
  americanEnglish: { status: 'shared' as const, explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph of a printed report on a desk, without text.',
});

/** A saved sentence and the bundle entry that analyses it. */
function sentence(id: string, text: string, fields: Record<string, unknown> = {}) {
  saveItem(owner.id, id, 'sentence', { text, sourceWord: 'lucid' });
  return { id, textHash: sha256(text), analysis: analysis(`译文：${text}`), generatedAt: 100, ...fields };
}

/** Writes a bundle: its manifest, and each named image file with the given bytes. */
function bundle(entries: object[], images: Record<string, Buffer | string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dictprop-sentence-backfill-bundle-'));
  mkdirSync(join(dir, 'images'));
  for (const [name, bytes] of Object.entries(images)) writeFileSync(join(dir, 'images', name), bytes);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, generatedAt: 100, entries }));
  return join(dir, 'manifest.json');
}

const runImport = (manifest: string) =>
  runServerScript('import-sentence-backfill', [manifest], { DATA_DIR, OWNER_GOOGLE_EMAIL: OWNER_EMAIL });

test('a sentence whose bundle image is bad still gets its analysis, and the image is reported as an error', () => {
  const good = sentence('bi-good', 'The lucid report settled the question.', { imageFile: 'images/good.png' });
  const missing = sentence('bi-missing', 'Her lucid answer surprised us.', { imageFile: 'images/missing.png' });
  const corrupt = sentence('bi-corrupt', 'A lucid plan emerged overnight.', { imageFile: 'images/corrupt.png' });
  // A replacement that turns out empty leaves the stored image alone.
  const replaced = sentence('bi-replaced', 'His lucid notes helped everyone.', {
    imageFile: 'images/empty.png', replaceImage: true,
  });
  addItemImage(owner.id, 'bi-replaced');

  const run = runImport(bundle([good, missing, corrupt, replaced], {
    'good.png': png('bi-good'), 'corrupt.png': 'not an image', 'empty.png': Buffer.alloc(0),
  }));
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.output.analysesUpdated, 4);
  assert.equal(run.output.imagesAdded, 1);
  assert.equal(run.output.stale, 0);
  assert.equal(run.output.skipped, 0);
  assert.deepEqual(run.output.errors.map((error: { id: string }) => error.id), ['bi-missing', 'bi-corrupt', 'bi-replaced']);
  assert.match(run.output.errors[0].error, /^ENOENT: no such file or directory/);
  assert.equal(run.output.errors[1].error, 'image format is invalid');
  assert.equal(run.output.errors[2].error, 'image size is invalid');

  for (const entry of [good, missing, corrupt, replaced]) {
    assert.deepEqual(stored(entry.id).data.analysis, entry.analysis);
    assert.equal(stored(entry.id).data.analysisGeneratedAt, 100);
  }
  assert.equal(getItemImage('bi-good', owner.id), dataUri('bi-good'));
  assert.equal(getItemImage('bi-missing', owner.id), null);
  assert.equal(getItemImage('bi-corrupt', owner.id), null);
  assert.equal(getItemImage('bi-replaced', owner.id), dataUri('bi-replaced'));
});

test('a retried bundle leaves the sentences that already hold its analyses as they are', () => {
  const plain = sentence('bu-plain', 'The lucid summary came first.');
  const withImage = sentence('bu-image', 'A lucid diagram followed.', { imageFile: 'images/image.png' });
  const replacing = sentence('bu-replace', 'The lucid caption changed.', {
    imageFile: 'images/replace.png', replaceImage: true,
  });
  const manifest = bundle([plain, withImage, replacing], {
    'image.png': png('bu-image'), 'replace.png': png('bu-replace'),
  });
  const first = runImport(manifest);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.output.analysesUpdated, 3);
  assert.equal(first.output.unchanged, 0);
  const revisionAfterFirst = (id: string) => stored(id).serverRevision ?? 0;
  const plainRevision = revisionAfterFirst('bu-plain');
  const imageRevision = revisionAfterFirst('bu-image');

  const retry = runImport(manifest);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(Object.keys(retry.output), [
    'total', 'analysesUpdated', 'unchanged', 'imagesAdded', 'imagesReplaced', 'imagesPreserved', 'stale', 'staleIds',
    'skipped', 'errors', 'backup',
  ]);
  assert.equal(retry.output.unchanged, 2);
  assert.equal(retry.output.imagesPreserved, 1);
  // An explicit replacement is written again.
  assert.equal(retry.output.analysesUpdated, 1);
  assert.equal(retry.output.imagesReplaced, 1);
  assert.deepEqual(retry.output.errors, []);
  assert.equal(stored('bu-plain').serverRevision, plainRevision);
  assert.equal(stored('bu-image').serverRevision, imageRevision);
  assert.equal(getItemImage('bu-image', owner.id), dataUri('bu-image'));

  // A newer analysis of the same sentence is written as before.
  const newer = { ...plain, analysis: analysis('新的译文'), generatedAt: 200 };
  const update = runImport(bundle([newer]));
  assert.equal(update.status, 0, update.stderr);
  assert.equal(update.output.analysesUpdated, 1);
  assert.equal(update.output.unchanged, 0);
  assert.deepEqual(stored('bu-plain').data.analysis, newer.analysis);
  assert.ok((stored('bu-plain').serverRevision ?? 0) > plainRevision);
});
