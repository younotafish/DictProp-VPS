import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-data-layer-test-'));

const {
  db, deleteUnreferencedBlobs, getComparisons, getImageManifest, getItemById, getItemImage, getItemImagesBatch,
  getItemsAfterRevision, getSentenceEnrichmentImage, hasItemImage, softDeleteItem, upsertComparison, upsertItem,
  upsertItemImageBinary, upsertMany, upsertSentenceEnrichment,
} = await import('../src/db.js');
const { backupBeforeWrite, StaleEntryError, writeOverLiveItem } = await import('../src/import-support.js');
const { sentenceLookupHash } = await import('../src/sentence-enrichment.js');

const USER = 'data-layer-user';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const png = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
const srs = (id: string, type: string) => ({
  id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0,
});
const vocab = (id: string, data: Record<string, unknown>, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  type: 'vocab', data: { id, word: 'lucid', ...data }, srs: srs(id, 'vocab'), savedAt: 1, updatedAt, ...extra,
});
const stored = (id: string) => getItemById(id, USER, false) as any;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const headRevision = () => getItemsAfterRevision({ revision: 0, id: '' }, 1, USER).headRevision;

const audit = { status: 'current_general', reason: 'Normal in current American English.', confidence: 'high', auditedAt: 1 };
const advanced = { version: 1, provider: 'claude-code', model: 'test-model', generatedAt: 2, contentHash: 'a'.repeat(64) };
const localImage = { version: 1, provider: 'local-ernie', model: 'test-image-model', generatedAt: 3, promptHash: 'b'.repeat(64) };
const analysis = {
  translation: '她清楚地讲述了经过。',
  americanEnglish: { status: 'shared' as const, explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph of a person explaining something calmly, without text.',
};
const enrich = (text: string, image: Buffer) => {
  const lookupHash = sentenceLookupHash(text);
  upsertSentenceEnrichment({
    entry: { id: `example-${lookupHash.slice(0, 40)}`, text, lookupHash, textHash: sha256(text), analysis, generatedAt: 10 },
    image,
    mimeType: 'image/png',
  });
  return lookupHash;
};

test('a write from a copy made before a server job ran keeps the fields that job added', () => {
  upsertItem(vocab('carry-vocab', {
    definition: 'clear', usageAudit: audit, advancedEnrichment: advanced, localImageEnrichment: localImage,
  }, 1_000), USER);
  upsertItem(vocab('carry-vocab', { definition: 'easily understood' }, 2_000), USER);
  let item = stored('carry-vocab');
  assert.equal(item.data.definition, 'easily understood');
  assert.deepEqual(item.data.usageAudit, audit);
  assert.deepEqual(item.data.advancedEnrichment, advanced);
  assert.deepEqual(item.data.localImageEnrichment, localImage);

  // A value the write does carry replaces the stored one.
  const reaudit = { ...audit, reason: 'Common in the US.', auditedAt: 4 };
  upsertItem(vocab('carry-vocab', { definition: 'easily understood', usageAudit: reaudit }, 3_000), USER);
  item = stored('carry-vocab');
  assert.deepEqual(item.data.usageAudit, reaudit);
  assert.deepEqual(item.data.advancedEnrichment, advanced);
});

test('a sentence keeps its analysis only while its text is unchanged', () => {
  const sentence = (text: string, data: Record<string, unknown>, updatedAt: number) => ({
    type: 'sentence',
    data: { id: 'carry-sentence', text, sourceWord: 'lucid', ...data },
    srs: srs('carry-sentence', 'sentence'),
    savedAt: 1,
    updatedAt,
  });
  upsertItem(sentence('She gave a lucid account.', { analysis, analysisGeneratedAt: 7 }, 1_000), USER);
  // Kept, not returned to the saving client the way an analysis from the enrichment pool is.
  assert.deepEqual(upsertMany([sentence('She gave a lucid account.', { preferredSpeechStyle: 'casual' }, 2_000)], USER).enriched, []);
  let item = stored('carry-sentence');
  assert.deepEqual(item.data.analysis, analysis);
  assert.equal(item.data.analysisGeneratedAt, 7);
  assert.equal(item.data.preferredSpeechStyle, 'casual');

  upsertItem(sentence('She gave a lucid, calm account.', {}, 3_000), USER);
  item = stored('carry-sentence');
  assert.equal(item.data.text, 'She gave a lucid, calm account.');
  assert.equal(item.data.analysis, undefined);
  assert.equal(item.data.analysisGeneratedAt, undefined);
});

test('a phrase keeps each vocab\'s server fields by vocab id, not by position', () => {
  const phrase = (vocabs: unknown[], data: Record<string, unknown>, updatedAt: number) => ({
    type: 'phrase',
    data: { id: 'carry-phrase', query: 'lucid dream', vocabs, ...data },
    srs: srs('carry-phrase', 'phrase'),
    savedAt: 1,
    updatedAt,
  });
  upsertItem(phrase([
    { id: 'carry-phrase-lucid', word: 'lucid', usageAudit: audit, advancedEnrichment: advanced },
    { id: 'carry-phrase-dream', word: 'dream', localImageEnrichment: localImage },
  ], { localImageEnrichment: localImage }, 1_000), USER);
  upsertItem(phrase([
    { id: 'carry-phrase-dream', word: 'dream' },
    { id: 'carry-phrase-lucid', word: 'lucid', definition: 'clear' },
    { id: 'carry-phrase-vivid', word: 'vivid' },
  ], {}, 2_000), USER);

  const item = stored('carry-phrase');
  assert.deepEqual(item.data.localImageEnrichment, localImage);
  const [dream, lucid, vivid] = item.data.vocabs;
  assert.deepEqual(dream, { id: 'carry-phrase-dream', word: 'dream', localImageEnrichment: localImage });
  assert.deepEqual(lucid, {
    id: 'carry-phrase-lucid', word: 'lucid', definition: 'clear', usageAudit: audit, advancedEnrichment: advanced,
  });
  assert.deepEqual(vivid, { id: 'carry-phrase-vivid', word: 'vivid' });
});

test('a copy that differs from the row only by lacking kept fields leaves it and its revision alone', () => {
  upsertItem(vocab('carry-settles', { definition: 'clear', localImageEnrichment: localImage }, 1_000), USER);
  // A fresh result saved over the card: new content, without the marker.
  const base: number = stored('carry-settles').serverRevision;
  const fresh = vocab('carry-settles', { definition: 'easily understood' }, 2_000, { serverRevision: base });
  const revision = upsertMany([fresh], USER).revisions['carry-settles'];
  assert.ok(revision > base);
  assert.deepEqual(stored('carry-settles').data.localImageEnrichment, localImage);

  // Its client keeps its own copy at that revision and pushes the same copy again.
  const head = headRevision();
  assert.deepEqual(upsertMany([{ ...fresh, serverRevision: revision }], USER), {
    revisions: { 'carry-settles': revision }, conflicts: [], enriched: [],
  });
  assert.equal(headRevision(), head);
  assert.equal(stored('carry-settles').serverRevision, revision);

  // Any other change is written, and so is an image, which changes what the item reads back as.
  const withImage = { ...fresh, serverRevision: revision, data: {
    ...fresh.data, imageUrl: `data:image/png;base64,${png('carry-settles').toString('base64')}`,
  } };
  const imaged = upsertMany([withImage], USER).revisions['carry-settles'];
  assert.ok(imaged > revision);
  assert.ok(hasItemImage('carry-settles', USER));
  const archived = upsertMany([{ ...fresh, serverRevision: imaged, isArchived: true }], USER).revisions['carry-settles'];
  assert.ok(archived > imaged);
  assert.equal(stored('carry-settles').isArchived, true);
  assert.deepEqual(stored('carry-settles').data.localImageEnrichment, localImage);
});

test('a prepared example saved again without its analysis still gets it back from the pool in the response', () => {
  const text = 'A lucid summary opened the report.';
  enrich(text, png('pool-first'));
  const sentence = (data: Record<string, unknown>, updatedAt: number) => ({
    type: 'sentence',
    data: { id: 'pool-first', text, sourceWord: 'lucid', ...data },
    srs: srs('pool-first', 'sentence'),
    savedAt: 1,
    updatedAt,
  });
  assert.deepEqual(upsertMany([sentence({}, 1_000)], USER).enriched, ['pool-first']);
  assert.deepEqual(upsertMany([sentence({ preferredSpeechStyle: 'clear' }, 2_000)], USER).enriched, ['pool-first']);
  assert.deepEqual(stored('pool-first').data.analysis, analysis);
  assert.equal(stored('pool-first').data.preferredSpeechStyle, 'clear');
});

test('server fields are not carried into deletions, revived rows, stale copies or the corpus import', () => {
  upsertItem(vocab('carry-deletion', { usageAudit: audit }, 1_000), USER);
  upsertItem(vocab('carry-deletion', {}, 2_000, { isDeleted: true }), USER);
  assert.equal(stored('carry-deletion').isDeleted, true);
  assert.equal(stored('carry-deletion').data.usageAudit, undefined);

  upsertItem(vocab('carry-revived', { usageAudit: audit }, 1_000), USER);
  softDeleteItem('carry-revived', USER);
  upsertItem(vocab('carry-revived', { definition: 'saved again' }, Date.now() + 1_000), USER);
  assert.equal(stored('carry-revived').isDeleted, undefined);
  assert.equal(stored('carry-revived').data.usageAudit, undefined);

  // A stale copy writes nothing, so the stored row keeps its content and fields as they are.
  upsertItem(vocab('carry-stale', { definition: 'current', usageAudit: audit }, 5_000), USER);
  assert.equal(upsertItem(vocab('carry-stale', { definition: 'older' }, 4_000), USER).conflicted, true);
  assert.equal(stored('carry-stale').data.definition, 'current');
  assert.deepEqual(stored('carry-stale').data.usageAudit, audit);

  // The corpus-audit import writes whole items whose data must hash to the audited target.
  upsertItem(vocab('carry-corpus', { usageAudit: audit }, 1_000), USER);
  upsertMany([vocab('carry-corpus', { definition: 'audited' }, 2_000)], USER, { replaceServerFields: true });
  assert.equal(stored('carry-corpus').data.definition, 'audited');
  assert.equal(stored('carry-corpus').data.usageAudit, undefined);
});

test('a stored image whose blob is gone reads as no image and can be uploaded again', () => {
  const image = png('blob-gone');
  upsertItem(vocab('blob-gone', {}, 1_000), USER);
  assert.equal(upsertItemImageBinary('blob-gone', image, 'image/png', USER), true);
  assert.match(stored('blob-gone').data.imageUrl, /^server:has_image:[a-f0-9]{20}$/);
  db.prepare('DELETE FROM image_blobs WHERE content_hash = ?').run(sha256(image));

  assert.equal(getItemImage('blob-gone', USER), null);
  assert.deepEqual(getItemImagesBatch(['blob-gone'], USER), {});
  assert.equal(stored('blob-gone').data.imageUrl, undefined);
  assert.equal((getItemById('blob-gone', USER) as any).data.imageUrl, undefined);
  assert.equal(hasItemImage('blob-gone', USER), false);
  // Left out of the manifest, so a client still holding the image uploads it again.
  assert.equal(getImageManifest(USER).includes('blob-gone'), false);

  assert.equal(upsertItemImageBinary('blob-gone', image, 'image/png', USER), true);
  assert.equal(getItemImage('blob-gone', USER), `data:image/png;base64,${image.toString('base64')}`);
  assert.equal(getImageManifest(USER).includes('blob-gone'), true);
});

test('saving a prepared example does not link an enrichment image whose blob is gone', () => {
  const text = 'The lucid witness explained everything.';
  const image = png('enrichment-gone');
  enrich(text, image);
  db.prepare('DELETE FROM image_blobs WHERE content_hash = ?').run(sha256(image));

  upsertItem({
    type: 'sentence',
    data: { id: 'enrichment-gone', text, sourceWord: 'lucid' },
    srs: srs('enrichment-gone', 'sentence'),
    savedAt: 1,
    updatedAt: 1,
  }, USER);
  const item = stored('enrichment-gone');
  assert.deepEqual(item.data.analysis, analysis);
  assert.equal(item.data.imageUrl, undefined);
  assert.equal(db.prepare('SELECT 1 FROM item_images WHERE id = ?').get('enrichment-gone'), undefined);
});

test('blob cleanup keeps a blob a prepared example sentence still uses', () => {
  const shared = png('shared-blob');
  const lookupHash = enrich('A lucid moment of clarity.', shared);
  upsertItem(vocab('blob-shared', {}, 1_000), USER);
  assert.equal(upsertItemImageBinary('blob-shared', shared, 'image/png', USER), true);
  // Replacing the item's image drops the item's reference; the enrichment still shows the old blob.
  assert.equal(upsertItemImageBinary('blob-shared', png('blob-shared-new'), 'image/png', USER), true);
  assert.deepEqual(getSentenceEnrichmentImage(lookupHash)?.data, shared);
  assert.equal(deleteUnreferencedBlobs([sha256(shared)]), 0);

  const orphan = png('orphan-blob');
  db.prepare('INSERT INTO image_blobs (content_hash, data, byte_length, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(orphan), orphan, orphan.length, 1);
  const before = count('image_blobs');
  assert.equal(deleteUnreferencedBlobs(), 1);
  assert.equal(count('image_blobs'), before - 1);
  assert.equal(db.prepare('SELECT 1 FROM image_blobs WHERE content_hash = ?').get(sha256(orphan)), undefined);
  assert.deepEqual(getSentenceEnrichmentImage(lookupHash)?.data, shared);
  assert.ok(getItemImage('blob-shared', USER));
});

test('blob cleanup and phrase scans search their indexes instead of scanning tables', () => {
  const plan = (sql: string, ...params: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
      .map(row => row.detail).join('\n');
  // The reference checks of deleteUnreferencedBlobs in db.ts.
  const references = `NOT EXISTS (
      SELECT 1 FROM item_images WHERE item_images.content_hash = image_blobs.content_hash
    ) AND NOT EXISTS (
      SELECT 1 FROM sentence_enrichments WHERE sentence_enrichments.image_content_hash = image_blobs.content_hash
    )`;
  for (const cleanup of [
    plan(`DELETE FROM image_blobs WHERE content_hash = ? AND ${references}`, 'hash'),
    plan(`DELETE FROM image_blobs WHERE ${references}`),
  ]) {
    assert.match(cleanup, /SEARCH item_images USING COVERING INDEX idx_item_images_content_hash/);
    assert.match(cleanup, /SEARCH sentence_enrichments USING COVERING INDEX idx_sentence_enrichments_image/);
  }
  // The phrase lookups of touchItemRevisions and the inline-image fallback.
  const phrases = plan(`SELECT id, data FROM items WHERE user_id = ? AND type = 'phrase' AND data LIKE ?`, USER, '%x%');
  assert.match(phrases, /SEARCH items USING INDEX idx_items_user_type/);
});

test('soft-deleting an id the user does not have leaves the revision clock alone', () => {
  const before = headRevision();
  assert.equal(softDeleteItem('never-saved', USER), false);
  assert.equal(headRevision(), before);

  upsertItem(vocab('soft-delete-me', {}, 1_000), USER);
  const saved = headRevision();
  assert.equal(softDeleteItem('soft-delete-me', 'another-user'), false);
  assert.equal(headRevision(), saved);
  assert.equal(softDeleteItem('soft-delete-me', USER), true);
  assert.equal(headRevision(), saved + 1);
  assert.equal(stored('soft-delete-me').isDeleted, true);
});

test('an older copy of a comparison does not replace a newer one', () => {
  assert.equal(upsertComparison(USER, 'lucid|clear', ['lucid', 'clear'], { summary: 'newer' }, 2_000), true);
  assert.equal(upsertComparison(USER, 'lucid|clear', ['lucid', 'clear'], { summary: 'older' }, 1_000), false);
  assert.deepEqual(getComparisons(USER).find(comparison => comparison.key === 'lucid|clear')?.data, { summary: 'newer' });
  assert.equal(upsertComparison(USER, 'lucid|clear', ['lucid', 'clear'], { summary: 'resaved' }, 2_000), true);
  assert.deepEqual(getComparisons(USER).find(comparison => comparison.key === 'lucid|clear')?.data, { summary: 'resaved' });
});

test('an import writing over an item that changed after it was read finds the entry stale instead of overwriting it', () => {
  upsertItem(vocab('import-race', { definition: 'first' }, 1_000), USER);
  const live = stored('import-race');
  upsertItem(vocab('import-race', { definition: 'edited on a phone' }, 2_000), USER);
  assert.throws(
    () => writeOverLiveItem(live, USER, { ...live.data, definition: 'imported' }),
    (error: unknown) => error instanceof StaleEntryError && error.message === 'item changed while it was being imported',
  );
  assert.equal(stored('import-race').data.definition, 'edited on a phone');

  const current = stored('import-race');
  writeOverLiveItem(current, USER, { ...current.data, definition: 'imported' });
  assert.equal(stored('import-race').data.definition, 'imported');
  assert.ok(stored('import-race').serverRevision > current.serverRevision);
});

test('imports back up the live database at most hourly and keep only the newest two copies', async () => {
  const dir = join(process.env.DATA_DIR!, 'backups');
  const first = await backupBeforeWrite('first');
  assert.match(first, /\/backups\/pre-first-\d{8}T\d{6}Z\.db$/);
  const copy = new Database(first, { readonly: true });
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, count('items'));
  copy.close();

  // The next import within the hour reuses that copy; a repair asks for a fresh one.
  assert.equal(await backupBeforeWrite('second'), first);
  const fresh = await backupBeforeWrite('fresh', { reuseRecent: false });
  assert.notEqual(fresh, first);

  // Once both are older than an hour, a new copy replaces the older one. A crashed run's partial copy
  // is removed; the deploy workflow's own backups are left alone.
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
  utimesSync(first, hoursAgo(3), hoursAgo(3));
  utimesSync(fresh, hoursAgo(2), hoursAgo(2));
  writeFileSync(join(dir, 'pre-crashed-20260101T000000Z.db.partial'), 'incomplete');
  writeFileSync(join(dir, 'dictprop-20260101-000000.db'), 'deploy backup');
  const third = await backupBeforeWrite('third');
  assert.deepEqual(readdirSync(dir).sort(), [basename(fresh), basename(third), 'dictprop-20260101-000000.db'].sort());
});
