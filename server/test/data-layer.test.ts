import assert from 'node:assert/strict';
import { readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { exampleSentenceId } from '../src/sentence-lookup.js';
import { srs } from './support/fixtures.js';
import { png, sha256 } from './support/fs.js';

const {
  db, deleteUnreferencedBlobs, forEachItemChunk, getAllItems, getComparisons, getImageManifest, getItemById,
  getItemImage, getItemImagesBatch, getItemsAfterRevision, getSentenceEnrichmentImage, hasItemImage, softDeleteItem,
  upsertComparison, upsertItem, upsertItemImageBinary, upsertMany, upsertSentenceEnrichment,
} = await import('../src/db.js');
const { backupBeforeWrite, StaleEntryError, writeOverLiveItem } = await import('../src/import-support.js');
const { sentenceLookupHash } = await import('../src/sentence-enrichment.js');

const USER = 'data-layer-user';
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
    entry: { id: exampleSentenceId(lookupHash), text, lookupHash, textHash: sha256(text), analysis, generatedAt: 10 },
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
  const write = upsertMany([fresh], USER);
  const revision = write.revisions['carry-settles'];
  assert.ok(revision > base);
  assert.deepEqual(stored('carry-settles').data.localImageEnrichment, localImage);
  assert.deepEqual(write.kept, { 'carry-settles': { localImageEnrichment: localImage } });

  // A client that ignores what was kept stays on its own copy at that revision and pushes the same copy again.
  const head = headRevision();
  assert.deepEqual(upsertMany([{ ...fresh, serverRevision: revision }], USER), {
    revisions: { 'carry-settles': revision }, conflicts: [], enriched: [],
    kept: { 'carry-settles': { localImageEnrichment: localImage } },
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

test('a write reports the stored server-owned fields it kept, by id, and nothing when it kept none', () => {
  const kept = (items: Parameters<typeof upsertMany>[0], options = {}) => upsertMany(items, USER, options).kept;
  upsertItem(vocab('kept-report', { definition: 'clear', usageAudit: audit, advancedEnrichment: advanced }, 1_000), USER);
  const revision = () => stored('kept-report').serverRevision as number;
  assert.deepEqual(kept([vocab('kept-report', { definition: 'edited' }, 2_000, { serverRevision: revision() })]), {
    'kept-report': { usageAudit: audit, advancedEnrichment: advanced },
  });
  // A write that carries every field the row has keeps nothing.
  assert.deepEqual(kept([vocab('kept-report', {
    definition: 'edited again', usageAudit: audit, advancedEnrichment: advanced,
  }, 3_000, { serverRevision: revision() })]), {});
  // Nor do a stale copy, a deletion or a whole-item import, which keep no field.
  assert.deepEqual(kept([vocab('kept-report', { definition: 'stale' }, 2_500, { serverRevision: revision() - 1 })]), {});
  assert.deepEqual(kept([vocab('kept-report', {}, 4_000, { serverRevision: revision() })], { replaceServerFields: true }), {});
  upsertItem(vocab('kept-deleted', { usageAudit: audit }, 1_000), USER);
  assert.deepEqual(kept([vocab('kept-deleted', {}, 2_000, { isDeleted: true })]), {});

  // A sentence's analysis goes with the text it analyzed; a phrase's fields go by vocab id.
  const sentence = (data: Record<string, unknown>, updatedAt: number) => ({
    type: 'sentence', data: { id: 'kept-sentence', text: 'Her lucid reply settled it.', sourceWord: 'lucid', ...data },
    srs: srs('kept-sentence', 'sentence'), savedAt: 1, updatedAt,
  });
  upsertItem(sentence({ analysis, analysisGeneratedAt: 7 }, 1_000), USER);
  assert.deepEqual(kept([sentence({ preferredSpeechStyle: 'casual' }, 2_000)]), {
    'kept-sentence': { text: 'Her lucid reply settled it.', analysis, analysisGeneratedAt: 7 },
  });
  const phrase = (vocabs: unknown[], updatedAt: number) => ({
    type: 'phrase', data: { id: 'kept-phrase', query: 'lucid dream', vocabs }, srs: srs('kept-phrase', 'phrase'),
    savedAt: 1, updatedAt,
  });
  upsertItem(phrase([{ id: 'kept-lucid', word: 'lucid', usageAudit: audit }, { id: 'kept-dream', word: 'dream' }], 1_000), USER);
  assert.deepEqual(kept([phrase([{ id: 'kept-dream', word: 'dream' }, { id: 'kept-lucid', word: 'lucid' }], 2_000)]), {
    'kept-phrase': { vocabs: [{ id: 'kept-lucid', usageAudit: audit }] },
  });
});

test('a sentence the pool analyses as it is saved goes back whole, so nothing is reported as kept for it', () => {
  const text = 'A lucid preface framed the whole report.';
  const sentence = (data: Record<string, unknown>, updatedAt: number) => ({
    type: 'sentence', data: { id: 'pool-kept', text, sourceWord: 'lucid', ...data }, srs: srs('pool-kept', 'sentence'),
    savedAt: 1, updatedAt,
  });
  // Saved before the pool had the sentence; the save after it carries neither the audit nor an analysis.
  upsertItem(sentence({ usageAudit: audit }, 1_000), USER);
  assert.equal(stored('pool-kept').data.analysis, undefined);
  enrich(text, png('pool-kept'));
  const write = upsertMany([sentence({}, 2_000)], USER);
  assert.deepEqual(write.enriched, ['pool-kept']);
  assert.deepEqual(write.kept, {});
  assert.deepEqual(stored('pool-kept').data.usageAudit, audit);
  assert.deepEqual(stored('pool-kept').data.analysis, analysis);
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

test('forEachItemChunk hands over every item once, in rowid order, 500 at a time, and can keep to one type', async () => {
  const owner = 'chunk-reader-user';
  const typeAt = (index: number) => (index % 5 === 0 ? 'vocab' : index % 5 === 1 ? 'phrase' : 'sentence');
  // The ids run backwards, so the order they were written in, rowid order, is not id order.
  const written = Array.from({ length: 1_201 }, (_, index) => {
    const id = `chunk-${String(1_200 - index).padStart(4, '0')}`;
    return { type: typeAt(index), data: { id, word: id }, srs: srs(id, typeAt(index)), savedAt: 1, updatedAt: 1_000 };
  });
  upsertMany(written, owner);

  const sizes: number[] = [];
  const seen: unknown[] = [];
  await forEachItemChunk(owner, async items => {
    await new Promise(resolve => setImmediate(resolve));
    // Written while the first chunk is still being handled: the next chunk is read after that, so it comes last.
    if (sizes.length === 0) upsertItem(vocab('chunk-late', {}, 1_000), owner);
    sizes.push(items.length);
    seen.push(...items);
  });
  assert.deepEqual(sizes, [500, 500, 202]);
  assert.deepEqual(seen, getAllItems(owner));
  assert.deepEqual(getAllItems(owner).map(item => item.data.id), [...written.map(item => item.data.id), 'chunk-late']);

  const sentenceSizes: number[] = [];
  const sentenceIds: string[] = [];
  await forEachItemChunk(owner, items => {
    sentenceSizes.push(items.length);
    for (const item of items) sentenceIds.push(item.data.id);
  }, { type: 'sentence' });
  const expected = written.filter(item => item.type === 'sentence').map(item => item.data.id);
  assert.equal(expected.length, 720);
  assert.deepEqual(sentenceSizes, [500, 220]);
  assert.deepEqual(sentenceIds, expected);
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

test('imports and deploys share one backup, which imports reuse for twelve hours', async () => {
  const dir = join(process.env.DATA_DIR!, 'backups');
  const first = await backupBeforeWrite('first');
  assert.match(first, /\/backups\/pre-first-\d{8}T\d{6}Z\.db$/);
  const copy = new Database(first, { readonly: true });
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n, count('items'));
  copy.close();

  // The next import reuses that copy; a repair asks for a fresh one, which replaces it.
  assert.equal(await backupBeforeWrite('second'), first);
  const fresh = await backupBeforeWrite('fresh', { reuseRecent: false });
  assert.notEqual(fresh, first);
  assert.deepEqual(readdirSync(dir), [basename(fresh)]);

  // A deploy's copy is reused like an import's.
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
  utimesSync(fresh, hoursAgo(13), hoursAgo(13));
  const deployed = join(dir, 'dictprop-20260101T000000Z-0123abc.db');
  writeFileSync(deployed, 'deploy backup');
  writeFileSync(`${deployed}-shm`, '');
  utimesSync(deployed, hoursAgo(11), hoursAgo(11));
  assert.equal(await backupBeforeWrite('third'), deployed);

  // Once every copy is older than twelve hours, a new copy replaces them all, with the files that opening
  // one left. A crashed run's partial copy is removed.
  utimesSync(deployed, hoursAgo(12.5), hoursAgo(12.5));
  writeFileSync(`${fresh}-wal`, '');
  writeFileSync(join(dir, 'dictprop-20260101T010000Z-4567def.db.partial'), 'incomplete');
  const fourth = await backupBeforeWrite('fourth');
  assert.match(fourth, /\/backups\/pre-fourth-\d{8}T\d{6}Z\.db$/);
  assert.deepEqual(readdirSync(dir), [basename(fourth)]);
});
