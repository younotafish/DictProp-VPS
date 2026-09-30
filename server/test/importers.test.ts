import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-importers-test-'));
const OWNER_EMAIL = 'owner@example.com';
process.env.DATA_DIR = DATA_DIR;
process.env.OWNER_GOOGLE_EMAIL = OWNER_EMAIL;

const { corpusSourceHash } = await import('../src/corpus-audit.js');
const {
  createUserAndClaimItems, db, getItemById, getItemImage, getSentenceEnrichmentImage, softDeleteItem, upsertItem,
  upsertItemImageBinary, upsertSentenceEnrichment,
} = await import('../src/db.js');
const { sentenceLookupHash } = await import('../src/sentence-enrichment.js');

const owner = createUserAndClaimItems({ googleId: 'importer-owner', email: OWNER_EMAIL, displayName: null, photoUrl: null });
const serverDir = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const png = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
const dataUri = (seed: string) => `data:image/png;base64,${png(seed).toString('base64')}`;
const srs = (id: string, type: string) => ({
  id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0,
});
const save = (id: string, type: string, data: Record<string, unknown>, updatedAt = 1_000) =>
  upsertItem({ type, data: { id, ...data }, srs: srs(id, type), savedAt: 1, updatedAt }, owner.id);
const stored = (id: string) => getItemById(id, owner.id, false) as any;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const walBytes = () => {
  const wal = join(DATA_DIR, 'dictprop.db-wal');
  return existsSync(wal) ? statSync(wal).size : 0;
};
const analysis = {
  translation: '这份清晰的报告解决了问题。',
  americanEnglish: { status: 'shared' as const, explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph of a printed report on a desk, without text.',
};

function bundle(files: string[], manifest: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'dictprop-importers-bundle-'));
  mkdirSync(join(dir, 'images'));
  for (const id of files) writeFileSync(join(dir, 'images', `${id}.png`), png(id));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return join(dir, 'manifest.json');
}

// The scripts run as they do in production: their own process and connection on the same database.
function runScript(name: string, ...args: string[]) {
  const { NODE_TEST_CONTEXT: _testContext, ...parentEnv } = process.env;
  const child = spawnSync(process.execPath, ['--import', 'tsx', `src/scripts/${name}.ts`, ...args], {
    cwd: serverDir,
    env: { ...parentEnv, DATA_DIR, OWNER_GOOGLE_EMAIL: OWNER_EMAIL },
    encoding: 'utf8',
  });
  const lines = child.stdout.trim().split('\n');
  return { status: child.status, stderr: child.stderr, output: JSON.parse(lines[lines.length - 1] || 'null') };
}

test('the sentence backfill skips sentences edited or deleted after export without failing the run', () => {
  const texts: Record<string, string> = {
    'bf-ok': 'The lucid report settled the question.',
    'bf-changed': 'Her lucid answer surprised us.',
    'bf-deleted': 'A lucid plan emerged overnight.',
  };
  for (const [id, text] of Object.entries(texts)) save(id, 'sentence', { text, sourceWord: 'lucid' });
  const entry = (id: string, text: string) => ({
    id, textHash: sha256(text), analysis, generatedAt: 100, imageFile: `images/${id}.png`,
  });
  const manifest = bundle(Object.keys(texts), {
    version: 1,
    generatedAt: 100,
    entries: Object.entries(texts).map(([id, text]) => entry(id, text)),
  });
  // Changed on a device while the bundle was being generated.
  save('bf-changed', 'sentence', { text: 'Her lucid answer surprised everyone.', sourceWord: 'lucid' }, 2_000);
  softDeleteItem('bf-deleted', owner.id);

  const run = runScript('import-sentence-backfill', manifest);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.analysesUpdated, 1);
  assert.equal(run.output.imagesAdded, 1);
  assert.equal(run.output.stale, 2);
  assert.deepEqual(run.output.staleIds, ['bf-changed', 'bf-deleted']);
  assert.equal(run.output.skipped, 0);
  assert.deepEqual(run.output.errors, []);
  assert.match(run.output.backup, /\/backups\/pre-sentence-backfill-\d{8}T\d{6}Z\.db$/);
  assert.equal(walBytes(), 0);

  assert.deepEqual(stored('bf-ok').data.analysis, analysis);
  assert.equal(stored('bf-ok').data.analysisGeneratedAt, 100);
  assert.equal(getItemImage('bf-ok', owner.id), dataUri('bf-ok'));
  assert.equal(stored('bf-changed').data.text, 'Her lucid answer surprised everyone.');
  for (const id of ['bf-changed', 'bf-deleted']) {
    assert.equal(stored(id).data.analysis, undefined);
    assert.equal(getItemImage(id, owner.id), null);
  }

  // An exported id that now holds another kind of item is an error, not a stale entry.
  save('bf-vocab', 'vocab', { word: 'lucid' });
  const typeChanged = runScript('import-sentence-backfill', bundle(['bf-vocab'], {
    version: 1, generatedAt: 100, entries: [entry('bf-vocab', 'Lucid.')],
  }));
  assert.equal(typeChanged.status, 1, typeChanged.stderr);
  assert.equal(typeChanged.output.stale, 0);
  assert.deepEqual(typeChanged.output.errors, [{ id: 'bf-vocab', error: 'item is no longer a sentence' }]);
  assert.equal(stored('bf-vocab').data.analysis, undefined);
  assert.equal(getItemImage('bf-vocab', owner.id), null);
});

test('the offline image import publishes images with their parent and skips parents changed after generation', () => {
  const prompts: Record<string, string> = {
    'oi-vocab': 'A limpid mountain lake at dawn.',
    'oi-phrase': 'A page of clear, simple prose.',
    'oi-phrase-limpid': 'Clear water running over stones.',
    'oi-changed': 'A glass of clear water on a table.',
    'oi-deleted': 'Ice crystals on a window.',
  };
  save('oi-vocab', 'vocab', { word: 'limpid', imagePrompt: prompts['oi-vocab'] });
  save('oi-phrase', 'phrase', {
    query: 'limpid prose',
    vocabs: [{ id: 'oi-phrase-limpid', word: 'limpid', imagePrompt: prompts['oi-phrase-limpid'] }],
  });
  save('oi-changed', 'vocab', { word: 'pellucid', imagePrompt: prompts['oi-changed'] });
  save('oi-deleted', 'vocab', { word: 'crystalline', imagePrompt: prompts['oi-deleted'] });
  const parentOf = (imageId: string) => imageId === 'oi-phrase-limpid' ? 'oi-phrase' : imageId;
  const manifest = bundle(Object.keys(prompts), {
    version: 1,
    generatedAt: 200,
    model: 'test-image-model',
    entries: Object.entries(prompts).map(([imageId, prompt]) => ({
      parentId: parentOf(imageId),
      imageId,
      parentHash: corpusSourceHash(stored(parentOf(imageId)).data),
      imageFile: `images/${imageId}.png`,
      promptHash: sha256(prompt),
    })),
  });
  save('oi-changed', 'vocab', { word: 'pellucid', definition: 'edited', imagePrompt: prompts['oi-changed'] }, 2_000);
  softDeleteItem('oi-deleted', owner.id);
  const revisionBefore = stored('oi-phrase').serverRevision;

  const run = runScript('import-offline-images', manifest);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.replaced, 3);
  assert.equal(run.output.stale, 2);
  assert.deepEqual(run.output.staleIds, ['oi-changed', 'oi-deleted']);
  assert.equal(run.output.skipped, 0);
  assert.deepEqual(run.output.errors, []);
  assert.match(run.output.backup, /\/backups\/pre-[a-z-]+-\d{8}T\d{6}Z\.db$/);
  assert.equal(walBytes(), 0);

  const marker = (imageId: string) => ({
    version: 1, provider: 'local-ernie', model: 'test-image-model', generatedAt: 200, promptHash: sha256(prompts[imageId]),
  });
  assert.deepEqual(stored('oi-vocab').data.localImageEnrichment, marker('oi-vocab'));
  assert.deepEqual(stored('oi-phrase').data.localImageEnrichment, marker('oi-phrase'));
  assert.deepEqual(stored('oi-phrase').data.vocabs[0].localImageEnrichment, marker('oi-phrase-limpid'));
  assert.ok(stored('oi-phrase').serverRevision > revisionBefore);
  for (const id of ['oi-vocab', 'oi-phrase', 'oi-phrase-limpid']) assert.equal(getItemImage(id, owner.id), dataUri(id));

  assert.equal(stored('oi-changed').data.definition, 'edited');
  for (const id of ['oi-changed', 'oi-deleted']) {
    assert.equal(stored(id).data.localImageEnrichment, undefined);
    assert.equal(getItemImage(id, owner.id), null);
  }

  // An image id that is neither the parent nor one of its vocabs is a malformed entry: an error.
  save('oi-other', 'vocab', { word: 'clear' });
  const stray = runScript('import-offline-images', bundle(['oi-stray'], {
    version: 1,
    generatedAt: 200,
    model: 'test-image-model',
    entries: [{
      parentId: 'oi-other',
      imageId: 'oi-stray',
      parentHash: corpusSourceHash(stored('oi-other').data),
      imageFile: 'images/oi-stray.png',
    }],
  }));
  assert.equal(stray.status, 1, stray.stderr);
  assert.equal(stray.output.stale, 0);
  assert.deepEqual(stray.output.errors, [{ id: 'oi-stray', error: 'image id does not belong to parent item' }]);
  assert.equal(getItemImage('oi-stray', owner.id), null);
});

test('the corpus audit import skips items edited or deleted after export without failing the run', () => {
  const usageAudit = { status: 'current_general', reason: 'Normal in current American English.', confidence: 'high', auditedAt: 300 };
  const words: Record<string, string> = { 'ca-ok': 'candid', 'ca-changed': 'frank', 'ca-deleted': 'blunt' };
  for (const [id, word] of Object.entries(words)) save(id, 'vocab', { word, definition: 'honest' });
  const entry = (id: string, type: string) => ({
    id,
    type,
    sourceHash: corpusSourceHash(stored(id).data),
    data: { ...stored(id).data, usageAudit },
    wasArchived: false,
    archiveForUsage: false,
  });
  const auditBundle = (entries: object[]) => {
    const path = join(mkdtempSync(join(tmpdir(), 'dictprop-importers-audit-')), 'audit.json');
    writeFileSync(path, JSON.stringify({ version: 1, generatedAt: 300, model: 'test-audit-model', entries }));
    return path;
  };
  const manifest = auditBundle(Object.keys(words).map(id => entry(id, 'vocab')));
  save('ca-changed', 'vocab', { word: 'frank', definition: 'edited' }, 2_000);
  softDeleteItem('ca-deleted', owner.id);

  const run = runScript('import-corpus-audit', manifest);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.updated, 1);
  assert.equal(run.output.stale, 2);
  assert.deepEqual(run.output.staleIds, ['ca-changed', 'ca-deleted']);
  assert.equal(run.output.skipped, 0);
  assert.deepEqual(run.output.errors, []);
  assert.equal(walBytes(), 0);
  assert.deepEqual(stored('ca-ok').data.usageAudit, usageAudit);
  assert.equal(stored('ca-changed').data.definition, 'edited');
  assert.equal(stored('ca-changed').data.usageAudit, undefined);

  // An exported id that now holds another kind of item is an error, not a stale entry.
  save('ca-sentence', 'sentence', { text: 'Be candid with me.', sourceWord: 'candid' });
  const typeChanged = runScript('import-corpus-audit', auditBundle([
    entry('ca-ok', 'vocab'),
    { ...entry('ca-sentence', 'sentence'), type: 'vocab', data: { id: 'ca-sentence', word: 'candid', usageAudit } },
  ]));
  assert.equal(typeChanged.status, 1, typeChanged.stderr);
  assert.equal(typeChanged.output.alreadyApplied, 1);
  assert.equal(typeChanged.output.stale, 0);
  assert.deepEqual(typeChanged.output.errors, [{ id: 'ca-sentence', error: 'item type changed after export' }]);
  assert.equal(stored('ca-sentence').type, 'sentence');
});

test('the repair only previews by default, and on --apply backs up first and keeps every image still in use', () => {
  const addImage = (id: string) => assert.equal(upsertItemImageBinary(id, png(id), 'image/png', owner.id), true);
  save('repair-live', 'vocab', { word: 'serene' });
  addImage('repair-live');
  save('repair-deleted', 'vocab', { word: 'placid' });
  addImage('repair-deleted');
  softDeleteItem('repair-deleted', owner.id);
  save('repair-phrase', 'phrase', { query: 'placid lake', vocabs: [{ id: 'repair-phrase-vocab', word: 'placid' }] });
  addImage('repair-phrase-vocab');
  addImage('repair-orphan');
  const text = 'A serene lake reflected the hills.';
  const lookupHash = sentenceLookupHash(text);
  upsertSentenceEnrichment({
    entry: { id: `example-${lookupHash.slice(0, 40)}`, text, lookupHash, textHash: sha256(text), analysis, generatedAt: 10 },
    image: png('repair-enrichment'),
    mimeType: 'image/png',
  });
  const unused = png('repair-unused-blob');
  db.prepare('INSERT INTO image_blobs (content_hash, data, byte_length, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(unused), unused, unused.length, 1);
  const blobs = count('image_blobs');
  const references = count('item_images');

  const preview = runScript('repair-production-data');
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.output.mode, 'dry-run');
  assert.deepEqual(preview.output.staleImageReferenceIds, ['repair-orphan']);
  assert.equal(preview.output.backup, undefined);
  assert.equal(count('image_blobs'), blobs);
  assert.equal(count('item_images'), references);

  const applied = runScript('repair-production-data', '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.output.mode, 'applied');
  assert.equal(applied.output.deletedBlobCount, 2);
  assert.match(applied.output.backup, /\/backups\/pre-repair-\d{8}T\d{6}Z\.db$/);
  const backup = new Database(applied.output.backup, { readonly: true });
  assert.ok(backup.prepare('SELECT 1 FROM item_images WHERE id = ?').get('repair-orphan'));
  backup.close();
  assert.equal(walBytes(), 0);

  for (const id of ['repair-live', 'repair-deleted', 'repair-phrase-vocab']) assert.equal(getItemImage(id, owner.id), dataUri(id));
  assert.equal(getItemImage('repair-orphan', owner.id), null);
  assert.deepEqual(getSentenceEnrichmentImage(lookupHash)?.data, png('repair-enrichment'));
  assert.equal(db.prepare('SELECT 1 FROM image_blobs WHERE content_hash = ?').get(sha256(unused)), undefined);
  assert.equal(count('image_blobs'), blobs - 2);
});
