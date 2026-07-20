import { createHash } from 'crypto';
import { db, getAllItems, getImageManifest, listAllUsers } from '../db.js';
import { detectImageMimeType } from '../image-format.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';
import { isSentenceAnalysis } from '../sentence-analysis.js';
import { isUsageAudit, shouldArchiveUsage, USAGE_STATUSES } from '../usage-audit.js';
import { validateStoredItem } from '../validation.js';

const users = listAllUsers();
const owner = users.find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const allItems = getAllItems(true, owner.id) as any[];
const liveItems = allItems.filter(item => !item.isDeleted);
const sample = (values: string[], limit = 100) => values.slice(0, limit);
const normalize = (value: unknown) => String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
const normalizeSentence = (value: unknown) => normalize(String(value || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1'));
const countQuery = (sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { count: number }).count;

const typeCounts = Object.fromEntries(['vocab', 'phrase', 'sentence'].map(type => [type, {
  live: liveItems.filter(item => item.type === type).length,
  archived: liveItems.filter(item => item.type === type && item.isArchived).length,
  deleted: allItems.filter(item => item.type === type && item.isDeleted).length,
}]));

const invalidItems = allItems.flatMap(item => {
  const error = validateStoredItem(item);
  return error ? [{ id: String(item?.data?.id || ''), error }] : [];
});

const missingUsageAudit: string[] = [];
const invalidUsageAudit: string[] = [];
const missingRequiredArchive: string[] = [];
const incompleteCardFields: Record<string, string[]> = Object.fromEntries(
  ['sense', 'definition', 'examples', 'history', 'register', 'mnemonic'].map(field => [field, []]),
);
const usageStatusCounts = Object.fromEntries(USAGE_STATUSES.map(status => [status, 0])) as Record<string, number>;
let auditedSenseCount = 0;

const checkCardCompleteness = (id: string, card: any) => {
  for (const field of ['sense', 'definition', 'history', 'register', 'mnemonic']) {
    if (typeof card?.[field] !== 'string' || !card[field].trim()) incompleteCardFields[field].push(id);
  }
  if (!Array.isArray(card?.examples) || card.examples.length === 0) incompleteCardFields.examples.push(id);
};

const checkUsage = (id: string, value: unknown, archived: boolean, enforceArchive = true) => {
  if (value === undefined) {
    missingUsageAudit.push(id);
    return;
  }
  if (!isUsageAudit(value)) {
    invalidUsageAudit.push(id);
    return;
  }
  auditedSenseCount++;
  usageStatusCounts[value.status]++;
  if (enforceArchive && shouldArchiveUsage(value.status, value.confidence) && !archived) missingRequiredArchive.push(id);
};

for (const item of liveItems) {
  checkUsage(item.data.id, item.data.usageAudit, item.isArchived === true);
  if (item.type === 'vocab') checkCardCompleteness(item.data.id, item.data);
  if (item.type === 'phrase' && Array.isArray(item.data.vocabs)) {
    for (const vocab of item.data.vocabs) {
      checkCardCompleteness(`${item.data.id}:${vocab?.id || '?'}`, vocab);
      // Nested cards cannot be archived independently without hiding the entire phrase. Their labels and
      // display ordering are still audited; only a top-level item drives the archive policy.
      checkUsage(`${item.data.id}:${vocab?.id || '?'}`, vocab?.usageAudit, item.isArchived === true, false);
    }
  }
}

const sentenceItems = liveItems.filter(item => item.type === 'sentence');
const invalidSentenceAnalysis = sentenceItems
  .filter(item => item.data.analysis !== undefined && !isSentenceAnalysis(item.data.analysis))
  .map(item => item.data.id);
const missingSentenceAnalysis = sentenceItems
  .filter(item => !isSentenceAnalysis(item.data.analysis))
  .map(item => item.data.id);
const missingAnalysisTimestamp = sentenceItems
  .filter(item => isSentenceAnalysis(item.data.analysis) &&
    !(typeof item.data.analysisGeneratedAt === 'number' && Number.isFinite(item.data.analysisGeneratedAt) && item.data.analysisGeneratedAt > 0))
  .map(item => item.data.id);

const imageIds = new Set(getImageManifest(owner.id));
const missingSentenceImages = sentenceItems.filter(item => !imageIds.has(item.data.id)).map(item => item.data.id);
const knownImageIds = new Set<string>();
const liveImageIds = new Set<string>();
for (const item of allItems) {
  if (typeof item?.data?.id === 'string') knownImageIds.add(item.data.id);
  if (!item.isDeleted && typeof item?.data?.id === 'string') liveImageIds.add(item.data.id);
  if (Array.isArray(item?.data?.vocabs)) {
    for (const vocab of item.data.vocabs) {
      if (typeof vocab?.id !== 'string') continue;
      knownImageIds.add(vocab.id);
      if (!item.isDeleted) liveImageIds.add(vocab.id);
    }
  }
}
const orphanImageIds = [...imageIds].filter(id => !knownImageIds.has(id));
const deletedItemImageIds = [...imageIds].filter(id => knownImageIds.has(id) && !liveImageIds.has(id));
const brokenImageRows: string[] = [];
const imageRows = db.prepare(`
  SELECT i.id, i.content_hash, i.mime_type, COALESCE(b.data, i.data) AS data, b.byte_length,
    CASE WHEN i.content_hash IS NOT NULL AND b.content_hash IS NULL THEN 1 ELSE 0 END AS missing_blob
  FROM item_images i LEFT JOIN image_blobs b ON b.content_hash = i.content_hash
  WHERE i.user_id = ?
`);
for (const row of imageRows.iterate(owner.id) as Iterable<{
  id: string;
  content_hash: string | null;
  mime_type: string | null;
  data: Buffer | string | null;
  byte_length: number | null;
  missing_blob: number;
}>) {
  let bytes: Buffer;
  if (Buffer.isBuffer(row.data)) {
    bytes = row.data;
  } else if (typeof row.data === 'string') {
    const comma = row.data.indexOf(',');
    bytes = comma >= 0 ? Buffer.from(row.data.slice(comma + 1), 'base64') : Buffer.alloc(0);
  } else {
    bytes = Buffer.alloc(0);
  }
  const detectedMime = detectImageMimeType(bytes);
  const hashMatches = !row.content_hash || createHash('sha256').update(bytes).digest('hex') === row.content_hash;
  const lengthMatches = row.byte_length === null || row.byte_length === bytes.length;
  const legacyMime = typeof row.data === 'string'
    ? row.data.match(/^data:(image\/(?:avif|gif|jpeg|png|webp));base64,/)?.[1] || null
    : null;
  const declaredMime = row.mime_type || legacyMime;
  if (row.missing_blob || !detectedMime || detectedMime !== declaredMime || !hashMatches || !lengthMatches) {
    brokenImageRows.push(row.id);
  }
}
const orphanImageBlobCount = (db.prepare(`
  SELECT COUNT(*) AS count FROM image_blobs b
  WHERE NOT EXISTS (SELECT 1 FROM item_images i WHERE i.content_hash = b.content_hash)
    AND NOT EXISTS (SELECT 1 FROM sentence_enrichments e WHERE e.image_content_hash = b.content_hash)
`).get() as { count: number }).count;
const sentenceEnrichmentStats = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN image_content_hash IS NOT NULL THEN 1 ELSE 0 END) AS with_images,
    SUM(CASE WHEN NOT json_valid(analysis) THEN 1 ELSE 0 END) AS invalid_analysis,
    SUM(CASE WHEN image_content_hash IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM image_blobs b WHERE b.content_hash = sentence_enrichments.image_content_hash
    ) THEN 1 ELSE 0 END) AS missing_blobs,
    COALESCE(SUM(CASE WHEN image_content_hash IS NOT NULL THEN (
      SELECT byte_length FROM image_blobs b WHERE b.content_hash = sentence_enrichments.image_content_hash
    ) ELSE 0 END), 0) AS image_bytes
  FROM sentence_enrichments
`).get() as {
  total: number;
  with_images: number | null;
  invalid_analysis: number | null;
  missing_blobs: number | null;
  image_bytes: number;
};

const duplicateGroups = (items: any[], keyOf: (item: any) => string) => {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const ids = groups.get(key) || [];
    ids.push(item.data.id);
    groups.set(key, ids);
  }
  return [...groups.values()].filter(ids => ids.length > 1).map(ids => ({ ids }));
};
const duplicateVocabSenses = duplicateGroups(
  liveItems.filter(item => item.type === 'vocab'),
  item => `${normalize(item.data.word)}\u0000${normalize(item.data.sense)}`,
);
const duplicatePhrases = duplicateGroups(
  liveItems.filter(item => item.type === 'phrase'),
  item => normalize(item.data.query),
);
const duplicateSentences = duplicateGroups(sentenceItems, item => normalizeSentence(item.data.text));
const duplicateExactSentences = duplicateGroups(
  sentenceItems,
  item => [normalizeSentence(item.data.text), normalize(item.data.sourceWord), normalize(item.data.sourceSense)].join('\u0000'),
);

const liveVocabWords = new Set(liveItems
  .filter(item => item.type === 'vocab')
  .map(item => normalize(item.data.word))
  .filter(Boolean));
const missingSentenceSources = sentenceItems
  .filter(item => normalize(item.data.sourceWord) && !liveVocabWords.has(normalize(item.data.sourceWord)))
  .map(item => item.data.id);

const projectTagCount = (db.prepare('SELECT COUNT(*) AS count FROM items WHERE user_id = ? AND project IS NOT NULL')
  .get(owner.id) as { count: number }).count;
const projectRowCount = (db.prepare('SELECT COUNT(*) AS count FROM projects WHERE user_id = ?')
  .get(owner.id) as { count: number }).count;
const inlineImageItemCount = (db.prepare(`SELECT COUNT(*) AS count FROM items WHERE user_id = ? AND data LIKE '%data:image/%'`)
  .get(owner.id) as { count: number }).count;
const nonOwnerItemCount = (db.prepare('SELECT COUNT(*) AS count FROM items WHERE user_id IS NULL OR user_id != ?')
  .get(owner.id) as { count: number }).count;
const nonOwnerSessionCount = (db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id != ? AND expires_at > ?')
  .get(owner.id, Date.now()) as { count: number }).count;
const databaseQuickCheck = (db.pragma('quick_check') as Array<Record<string, unknown>>)
  .flatMap(row => Object.values(row).map(String));
const foreignKeyViolationCount = (db.pragma('foreign_key_check') as unknown[]).length;
const invalidItemJsonCount = countQuery(`SELECT COUNT(*) AS count FROM items WHERE NOT json_valid(data) OR NOT json_valid(srs)`);
const itemIdentityMismatchCount = countQuery(`
  SELECT COUNT(*) AS count FROM items
  WHERE json_valid(data) AND json_valid(srs) AND (
    json_extract(data, '$.id') IS NULL OR json_extract(data, '$.id') != id OR
    json_extract(srs, '$.id') IS NULL OR json_extract(srs, '$.id') != id OR
    json_extract(srs, '$.type') IS NULL OR json_extract(srs, '$.type') != type
  )
`);
const invalidComparisonJsonCount = countQuery(`
  SELECT COUNT(*) AS count FROM comparisons WHERE NOT json_valid(words) OR NOT json_valid(data)
`);
const nonOwnerComparisonCount = countQuery('SELECT COUNT(*) AS count FROM comparisons WHERE user_id != ?', owner.id);
const orphanReviewEventCount = countQuery(`
  SELECT COUNT(*) AS count FROM review_events e
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id)
     OR NOT EXISTS (SELECT 1 FROM items i WHERE i.id = e.item_id AND i.user_id = e.user_id)
`);
const orphanReviewItemCount = countQuery(`
  SELECT COUNT(*) AS count FROM review_event_items r
  WHERE NOT EXISTS (SELECT 1 FROM review_events e WHERE e.id = r.event_id)
     OR NOT EXISTS (SELECT 1 FROM items i WHERE i.id = r.item_id)
`);

const report = {
  generatedAt: Date.now(),
  itemCounts: {
    totalRows: allItems.length,
    live: liveItems.length,
    deleted: allItems.length - liveItems.length,
    byType: typeCounts,
  },
  storageIntegrity: {
    invalidItemCount: invalidItems.length,
    invalidItems: invalidItems.slice(0, 100),
    legacyProjectTagCount: projectTagCount,
    legacyProjectRowCount: projectRowCount,
    inlineImageItemCount,
    registeredUserCount: users.length,
    registeredAdminCount: users.filter(user => user.is_admin === 1).length,
    nonOwnerItemCount,
    activeNonOwnerSessionCount: nonOwnerSessionCount,
    databaseQuickCheck,
    foreignKeyViolationCount,
    invalidItemJsonCount,
    itemIdentityMismatchCount,
    invalidComparisonJsonCount,
    nonOwnerComparisonCount,
    orphanReviewEventCount,
    orphanReviewItemCount,
  },
  usageAudit: {
    auditedSenseCount,
    statusCounts: usageStatusCounts,
    missingCount: missingUsageAudit.length,
    missingIds: sample(missingUsageAudit),
    invalidCount: invalidUsageAudit.length,
    invalidIds: sample(invalidUsageAudit),
    missingRequiredArchiveCount: missingRequiredArchive.length,
    missingRequiredArchiveIds: sample(missingRequiredArchive),
  },
  cardCompleteness: Object.fromEntries(Object.entries(incompleteCardFields).map(([field, ids]) => [field, {
    missingCount: ids.length,
    missingIds: sample(ids),
  }])),
  sentences: {
    total: sentenceItems.length,
    missingAnalysisCount: missingSentenceAnalysis.length,
    missingAnalysisIds: sample(missingSentenceAnalysis),
    invalidAnalysisCount: invalidSentenceAnalysis.length,
    invalidAnalysisIds: sample(invalidSentenceAnalysis),
    missingAnalysisTimestampCount: missingAnalysisTimestamp.length,
    missingAnalysisTimestampIds: sample(missingAnalysisTimestamp),
    missingImageCount: missingSentenceImages.length,
    missingImageIds: sample(missingSentenceImages),
    missingSourceWordCount: missingSentenceSources.length,
    missingSourceWordIds: sample(missingSentenceSources),
  },
  sentenceEnrichments: {
    total: sentenceEnrichmentStats.total,
    withImages: sentenceEnrichmentStats.with_images || 0,
    invalidAnalysisCount: sentenceEnrichmentStats.invalid_analysis || 0,
    missingBlobCount: sentenceEnrichmentStats.missing_blobs || 0,
    imageBytes: sentenceEnrichmentStats.image_bytes,
  },
  images: {
    storedCount: imageIds.size,
    orphanReferenceCount: orphanImageIds.length,
    orphanReferenceIds: sample(orphanImageIds),
    deletedItemReferenceCount: deletedItemImageIds.length,
    deletedItemReferenceIds: sample(deletedItemImageIds),
    brokenRowCount: brokenImageRows.length,
    brokenRowIds: sample(brokenImageRows),
    orphanBlobCount: orphanImageBlobCount,
  },
  duplicates: {
    vocabSenseGroupCount: duplicateVocabSenses.length,
    vocabSenseGroups: duplicateVocabSenses.slice(0, 100),
    phraseGroupCount: duplicatePhrases.length,
    phraseGroups: duplicatePhrases.slice(0, 100),
    sentenceGroupCount: duplicateSentences.length,
    sentenceGroups: duplicateSentences.slice(0, 100),
    exactSentenceGroupCount: duplicateExactSentences.length,
    exactSentenceGroups: duplicateExactSentences.slice(0, 100),
  },
};

process.stdout.write(`${JSON.stringify(report)}\n`);
