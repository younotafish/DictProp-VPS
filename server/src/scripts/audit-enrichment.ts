import { db, getAllItems, listAllUsers } from '../db.js';
import {
  summarizeExampleEnrichmentCoverage,
  type StoredSentenceEnrichmentRecord,
} from '../example-enrichment-coverage.js';
import { env } from '../env.js';
import { summarizeIncrementalEnrichmentBacklog } from '../incremental-enrichment.js';
import { isOwnerUser } from '../owner-access.js';

const HOUR_MS = 60 * 60 * 1_000;
const requestedLookback = Number(process.env.INCREMENTAL_ENRICHMENT_LOOKBACK_HOURS || 24);
const lookbackHours = Number.isFinite(requestedLookback)
  ? Math.max(1, Math.min(168, requestedLookback))
  : 24;
const prioritySince = Date.now() - lookbackHours * HOUR_MS;

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const items = getAllItems(true, owner.id);
const topLevel = summarizeIncrementalEnrichmentBacklog(items, prioritySince);
const storedExamples = [...db.prepare(`
  SELECT
    e.lookup_hash,
    e.analysis,
    CASE WHEN b.content_hash IS NOT NULL AND b.byte_length > 0
      THEN e.image_content_hash ELSE NULL END AS image_content_hash
  FROM sentence_enrichments e
  LEFT JOIN image_blobs b ON b.content_hash = e.image_content_hash
`).iterate() as Iterable<StoredSentenceEnrichmentRecord>];
const exampleSentenceCoverage = summarizeExampleEnrichmentCoverage(items, storedExamples);
const exampleGaps = exampleSentenceCoverage.expected - exampleSentenceCoverage.fullyEnriched;
const complete = topLevel.items === 0 && exampleGaps === 0;

console.log(JSON.stringify({
  mode: 'audit-only',
  prioritySince,
  complete,
  topLevel,
  exampleGaps,
  exampleSentenceCoverage,
}));

if (!complete) process.exitCode = 1;
