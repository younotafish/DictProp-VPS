import { db, getAllItems, listAllUsers } from '../db.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';
import { corpusSourceHash, type CorpusExportRecord } from '../corpus-audit.js';
import { hasCompleteSentenceAnalysis } from '../sentence-analysis.js';

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const items: CorpusExportRecord[] = getAllItems(true, owner.id)
  .filter(item => !item.isDeleted)
  .map(item => ({
    id: item.data.id,
    type: item.type,
    sourceHash: corpusSourceHash(item.data),
    wasArchived: item.isArchived === true,
    data: item.data,
  }));

const exampleEnrichmentCoverage: Array<{
  lookupHash: string;
  hasAnalysis: boolean;
  hasImage: boolean;
}> = [];
const enrichmentRows = db.prepare(`
  SELECT
    e.lookup_hash,
    e.analysis,
    EXISTS (
      SELECT 1 FROM image_blobs b
      WHERE b.content_hash = e.image_content_hash AND b.byte_length > 0
    ) AS has_image
  FROM sentence_enrichments e
  ORDER BY e.lookup_hash
`).iterate() as Iterable<{ lookup_hash: string; analysis: string; has_image: number }>;
for (const row of enrichmentRows) {
  let hasAnalysis = false;
  try {
    hasAnalysis = hasCompleteSentenceAnalysis(JSON.parse(row.analysis));
  } catch {
    // Malformed or obsolete records are intentionally exported as repair targets.
  }
  exampleEnrichmentCoverage.push({
    lookupHash: row.lookup_hash,
    hasAnalysis,
    hasImage: row.has_image === 1,
  });
}

process.stdout.write(JSON.stringify({
  version: 1,
  exportedAt: Date.now(),
  items,
  exampleEnrichmentCoverage,
}));
