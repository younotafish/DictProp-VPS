import assert from 'node:assert/strict';
import test from 'node:test';
import { completeAnalysis, srs } from './support/fixtures.js';
import { png, sha256 } from './support/fs.js';
import {
  addItemImage, createOwner, lastJsonLine, runScript, saveItem, storeExample, storeRawBlob, storeRawExample,
} from './support/library.js';

const { createSession, createUserAndClaimItems, db, softDeleteItem } = await import('../src/db.js');
const { exampleSentenceId, sentenceLookupHash } = await import('../src/sentence-lookup.js');

const owner = createOwner();
const save = (id: string, type: string, data: Record<string, unknown>) => saveItem(owner.id, id, type, data);
const ids = (texts: string[]) => texts.map(sentenceLookupHash).sort((left, right) => left.localeCompare(right))
  .map(exampleSentenceId);
// An analysis from before grammar and pronunciation were part of the contract.
const legacyAnalysis = {
  translation: '新的。',
  americanEnglish: { status: 'shared', explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph of something new, without text.',
};
const { pronunciation: _pronunciation, ...incompleteAnalysis } = completeAnalysis;
// An advanced-enrichment marker of a version validation doesn't know.
const unknownMarker = { version: 2 };
const examples = [
  'This example has everything it needs.',
  'This example lacks its pronunciation guide.',
  'This example lost its image blob.',
  'Nobody stored anything for this example.',
];

// Two spellings of one sense, two of one phrase, and two of one sentence once markup is set aside.
save('ap-candid', 'vocab', { word: 'Candid', sense: 'adj: frank', examples: examples.slice(0, 2) });
save('ap-candid-2', 'vocab', {
  word: 'candid ', sense: 'ADJ:  frank', examples: examples.slice(2), advancedEnrichment: unknownMarker,
});
save('ap-phrase-1', 'phrase', { query: 'Limpid prose', vocabs: [{ id: 'ap-nested', word: 'limpid' }] });
save('ap-phrase-2', 'phrase', { query: 'limpid  prose', vocabs: [], advancedEnrichment: unknownMarker });
save('ap-s1', 'sentence', {
  text: 'Keep {{going}} until the end.', sourceWord: 'candid', analysis: completeAnalysis, analysisGeneratedAt: 5,
  advancedEnrichment: {
    version: 1, provider: 'claude-code', model: 'claude', generatedAt: 5, contentHash: sha256('ap-s1'),
  },
});
addItemImage(owner.id, 'ap-s1');
save('ap-s2', 'sentence', { text: 'keep going until the [[end]].', sourceWord: 'Candid' });
// The same sentence with a straight and a curly apostrophe: one sentence, as the server's lookup reads it.
save('ap-s3', 'sentence', { text: "I don't know.", sourceWord: 'orphan-word' });
save('ap-s4', 'sentence', { text: 'I don’t know.', sourceWord: 'orphan-word' });
save('ap-inline', 'vocab', { word: 'inline', note: 'data:image/png;base64,AAAA' });
save('ap-deleted', 'vocab', { word: 'murky' });
addItemImage(owner.id, 'ap-deleted');
softDeleteItem('ap-deleted', owner.id);
// A deleted phrase keeps its data, marker and all, and a device can push it again.
save('ap-deleted-phrase', 'phrase', { query: 'turbid water', vocabs: [], advancedEnrichment: unknownMarker });
softDeleteItem('ap-deleted-phrase', owner.id);
addItemImage(owner.id, 'ap-orphan-image');
db.prepare(`INSERT INTO item_images (id, user_id, data, updated_at, mime_type, content_hash)
  VALUES ('ap-broken-image', ?, x'', 1, 'image/png', ?)`).run(owner.id, sha256('no such blob'));
storeRawBlob(png('nobody refers to this blob'));
// An image row from before image_blobs: a data URI in its own data column, and no content hash.
db.prepare(`INSERT INTO item_images (id, user_id, data, updated_at, mime_type, content_hash)
  VALUES ('ap-candid', ?, ?, 1, NULL, NULL)`)
  .run(owner.id, `data:image/png;base64,${png('legacy image').toString('base64')}`);

// A row no account owns, from before accounts existed.
db.prepare(`INSERT INTO items (id, type, data, srs, saved_at, updated_at, is_deleted, is_archived, user_id, revision)
  VALUES ('ap-unowned', 'vocab', ?, ?, 1, 1, 0, 0, NULL, 0)`)
  .run(JSON.stringify({ id: 'ap-unowned', word: 'stray' }), JSON.stringify(srs('ap-unowned', 'vocab')));
const other = createUserAndClaimItems({ googleId: 'other', email: 'other@example.com', displayName: null, photoUrl: null });
createSession(other.id);

storeExample(examples[0], completeAnalysis, png('stored example image'));
storeExample(examples[1], incompleteAnalysis);
storeRawExample(examples[2], JSON.stringify(completeAnalysis), sha256('gone'));
storeRawExample('An example stored as broken JSON.', '{"translation":', null);
storeExample('An example analysed before grammar was required.', legacyAnalysis);

test('the production audit reports storage, sentences, example enrichments, images and duplicates', () => {
  const run = runScript('audit-production-data');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.split('\n').length, 2);
  const report = lastJsonLine(run.stdout);

  assert.deepEqual(report.itemCounts, {
    totalRows: 11,
    live: 9,
    deleted: 2,
    byType: {
      vocab: { live: 3, archived: 0, deleted: 1 },
      phrase: { live: 2, archived: 0, deleted: 1 },
      sentence: { live: 4, archived: 0, deleted: 0 },
    },
  });
  assert.deepEqual(report.storageIntegrity, {
    invalidItemCount: 2,
    invalidItems: [
      { id: 'ap-candid-2', error: 'vocab advancedEnrichment is invalid' },
      { id: 'ap-inline', error: 'item has an inline image outside imageUrl' },
    ],
    // The live and the deleted phrase's markers: validation already refuses the vocab's, and the sentence's is valid.
    invalidTopLevelAdvancedEnrichmentCount: 2,
    inlineImageItemCount: 1,
    legacyImageRowCount: 1,
    registeredUserCount: 2,
    registeredAdminCount: 1,
    nonOwnerItemCount: 1,
    activeNonOwnerSessionCount: 1,
    databaseQuickCheck: ['ok'],
    foreignKeyViolationCount: 0,
    invalidItemJsonCount: 0,
    itemIdentityMismatchCount: 0,
    invalidComparisonJsonCount: 0,
    nonOwnerComparisonCount: 0,
    orphanReviewEventCount: 0,
    orphanReviewItemCount: 0,
  });
  assert.deepEqual(report.sentences, {
    total: 4,
    missingAnalysisCount: 3,
    missingAnalysisIds: ['ap-s2', 'ap-s3', 'ap-s4'],
    invalidAnalysisCount: 0,
    invalidAnalysisIds: [],
    missingGrammarCount: 3,
    missingGrammarIds: ['ap-s2', 'ap-s3', 'ap-s4'],
    incompleteDetailedAnalysisCount: 3,
    incompleteDetailedAnalysisIds: ['ap-s2', 'ap-s3', 'ap-s4'],
    missingAnalysisTimestampCount: 0,
    missingAnalysisTimestampIds: [],
    missingImageCount: 3,
    missingImageIds: ['ap-s2', 'ap-s3', 'ap-s4'],
    missingSourceWordCount: 2,
    missingSourceWordIds: ['ap-s3', 'ap-s4'],
  });
  assert.deepEqual(report.sentenceEnrichments, {
    total: 5,
    withImages: 2,
    invalidAnalysisCount: 1,
    missingGrammarCount: 2,
    incompleteDetailedAnalysisCount: 3,
    missingBlobCount: 1,
    imageBytes: png('stored example image').length,
  });
  assert.deepEqual(report.exampleSentenceCoverage, {
    expected: 4,
    fullyEnriched: 1,
    completeDetailedAnalysis: 2,
    missingAnalysis: 1,
    incompleteDetailedAnalysis: 1,
    withImage: 1,
    missingImage: 3,
    missingAnalysisIds: ids([examples[3]]),
    incompleteDetailedAnalysisIds: ids([examples[1]]),
    missingImageIds: ids(examples.slice(1)),
  });
  assert.deepEqual(report.images, {
    storedCount: 4,
    orphanReferenceCount: 1,
    orphanReferenceIds: ['ap-orphan-image'],
    deletedItemReferenceCount: 1,
    deletedItemReferenceIds: ['ap-deleted'],
    brokenRowCount: 1,
    brokenRowIds: ['ap-broken-image'],
    orphanBlobCount: 1,
  });
  assert.deepEqual(report.duplicates, {
    vocabSenseGroupCount: 1,
    vocabSenseGroups: [{ ids: ['ap-candid', 'ap-candid-2'] }],
    phraseGroupCount: 1,
    phraseGroups: [{ ids: ['ap-phrase-1', 'ap-phrase-2'] }],
    sentenceGroupCount: 2,
    sentenceGroups: [{ ids: ['ap-s1', 'ap-s2'] }, { ids: ['ap-s3', 'ap-s4'] }],
    exactSentenceGroupCount: 2,
    exactSentenceGroups: [{ ids: ['ap-s1', 'ap-s2'] }, { ids: ['ap-s3', 'ap-s4'] }],
  });
});
