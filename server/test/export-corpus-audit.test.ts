import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { completeAnalysis, completeVocab } from './support/fixtures.js';
import { png, sha256 } from './support/fs.js';
import {
  addItemImage, createOwner, lastJsonLine, runScript, saveItem, storeExample, storeRawBlob, storeRawExample,
} from './support/library.js';

const { corpusSourceHash } = await import('../src/corpus-audit.js');
const { getAllItems, getItemById, softDeleteItem } = await import('../src/db.js');
const { sentenceLookupHash } = await import('../src/sentence-lookup.js');

const owner = createOwner();
const save = (id: string, type: string, data: Record<string, unknown>, isArchived = false) =>
  saveItem(owner.id, id, type, data, { isArchived });
const { pronunciation: _pronunciation, ...incompleteAnalysis } = completeAnalysis;
const usageAudit = { status: 'current_general', reason: 'Normal in current American English.', confidence: 'high', auditedAt: 300 };

save('ce-vocab', 'vocab', { ...completeVocab, word: 'lucid' });
addItemImage(owner.id, 'ce-vocab');
save('ce-archived', 'vocab', { word: 'limpid', usageAudit }, true);
save('ce-sentence', 'sentence', {
  text: 'Her lucid answer settled it.', sourceWord: 'lucid', analysis: completeAnalysis, analysisGeneratedAt: 5,
});
save('ce-deleted', 'vocab', { word: 'murky' });
softDeleteItem('ce-deleted', owner.id);

storeExample('This example has everything it needs.', completeAnalysis, png('complete'));
storeExample('This example lacks its pronunciation guide.', incompleteAnalysis);
storeRawExample('This example was stored as broken JSON.', '{"translation":', null);
storeRawExample('This example lost its image blob.', JSON.stringify(completeAnalysis), sha256('gone'));
storeRawExample('This example points at an empty blob.', JSON.stringify(completeAnalysis), storeRawBlob(Buffer.alloc(0)));

test('the corpus export lists every live item with its source hash, and every stored example with its coverage', () => {
  const before = Date.now();
  const run = runScript('export-corpus-audit');
  const after = Date.now();
  assert.equal(run.status, 0, run.stderr);

  const exported = JSON.parse(run.stdout);
  // Compact JSON with nothing after it: the workflow pipes it straight into gzip and the bridge cipher.
  assert.equal(run.stdout, JSON.stringify(exported));
  assert.deepEqual(Object.keys(exported), ['version', 'exportedAt', 'items', 'exampleEnrichmentCoverage']);
  assert.equal(exported.version, 1);
  assert.ok(exported.exportedAt >= before && exported.exportedAt <= after);

  assert.deepEqual(exported.items.map((item: { id: string }) => item.id), ['ce-vocab', 'ce-archived', 'ce-sentence']);
  const live = getAllItems(owner.id).filter(item => !item.isDeleted);
  assert.deepEqual(exported.items, live.map(item => ({
    id: item.data.id,
    type: item.type,
    sourceHash: corpusSourceHash(item.data),
    wasArchived: item.isArchived === true,
    savedAt: item.savedAt,
    data: item.data,
  })));
  const [vocab, archived, sentence] = exported.items;
  assert.match(vocab.data.imageUrl, /^server:has_image:[a-f0-9]{20}$/);
  // The image marker is not part of the source an importer later checks its entry against.
  const { imageUrl: _marker, ...withoutMarker } = vocab.data;
  assert.equal(vocab.sourceHash, corpusSourceHash(withoutMarker));
  assert.equal(archived.wasArchived, true);
  assert.equal(sentence.wasArchived, false);
  assert.deepEqual(sentence.data.analysis, completeAnalysis);

  const coverage = [
    { text: 'This example has everything it needs.', hasAnalysis: true, hasImage: true },
    { text: 'This example lacks its pronunciation guide.', hasAnalysis: false, hasImage: false },
    { text: 'This example was stored as broken JSON.', hasAnalysis: false, hasImage: false },
    { text: 'This example lost its image blob.', hasAnalysis: true, hasImage: false },
    { text: 'This example points at an empty blob.', hasAnalysis: true, hasImage: false },
  ].map(({ text, ...flags }) => ({ lookupHash: sentenceLookupHash(text), ...flags }))
    .sort((left, right) => (left.lookupHash < right.lookupHash ? -1 : 1));
  assert.deepEqual(exported.exampleEnrichmentCoverage, coverage);
});

test('entries built from the export import cleanly: the export\'s source hash is the one the importer checks', () => {
  const exported = JSON.parse(runScript('export-corpus-audit').stdout);
  const entries = exported.items
    .filter((item: { id: string }) => item.id !== 'ce-archived')
    .map((item: { id: string; type: string; sourceHash: string; wasArchived: boolean; data: Record<string, unknown> }) => ({
      id: item.id,
      type: item.type,
      sourceHash: item.sourceHash,
      data: { ...item.data, usageAudit: { ...usageAudit, reason: `Audited ${item.id}.` } },
      wasArchived: item.wasArchived,
      archiveForUsage: false,
    }));
  // Through a file, as the workflow hands the importer its decrypted manifest.
  const manifest = join(process.env.TMPDIR!, 'corpus-audit-round-trip.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, generatedAt: 300, model: 'test-audit-model', entries }));

  const run = runScript('import-corpus-audit', [manifest]);
  assert.equal(run.status, 0, run.stderr);
  const report = lastJsonLine(run.stdout);
  assert.equal(report.updated, 2);
  assert.equal(report.stale, 0);
  assert.deepEqual(report.errors, []);
  for (const id of ['ce-vocab', 'ce-sentence']) {
    assert.equal(getItemById(id, owner.id, false)?.data.usageAudit.reason, `Audited ${id}.`);
  }
  // The sentence keeps the analysis its export carried.
  assert.deepEqual(getItemById('ce-sentence', owner.id, false)?.data.analysis, completeAnalysis);
});
