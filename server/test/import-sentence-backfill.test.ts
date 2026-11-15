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
