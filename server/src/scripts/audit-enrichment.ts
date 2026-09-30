import { db, getAllItems, listAllUsers } from '../db.js';
import { findStalledEnrichment } from '../enrichment-stall.js';
import {
  summarizeExampleEnrichmentCoverage,
  type StoredSentenceEnrichmentRecord,
} from '../example-enrichment-coverage.js';
import { env } from '../env.js';
import { summarizeIncrementalEnrichmentBacklog } from '../incremental-enrichment.js';
import { isOwnerUser } from '../owner-access.js';

const HOUR_MS = 60 * 60 * 1_000;
const numberFromEnv = (name: string, fallback: number, min: number, max: number): number => {
  const requested = Number(process.env[name] || fallback);
  return Number.isFinite(requested) ? Math.max(min, Math.min(max, requested)) : fallback;
};
const lookbackHours = numberFromEnv('INCREMENTAL_ENRICHMENT_LOOKBACK_HOURS', 24, 1, 168);
const prioritySince = Date.now() - lookbackHours * HOUR_MS;

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const items = getAllItems(owner.id);
const topLevel = summarizeIncrementalEnrichmentBacklog(items, prioritySince);
// Streamed on each read: the stored analyses run to several kilobytes apiece, tens of thousands of them.
const readStoredExamples = () => db.prepare(`
  SELECT
    e.lookup_hash,
    e.analysis,
    CASE WHEN b.content_hash IS NOT NULL AND b.byte_length > 0
      THEN e.image_content_hash ELSE NULL END AS image_content_hash
  FROM sentence_enrichments e
  LEFT JOIN image_blobs b ON b.content_hash = e.image_content_hash
`).iterate() as Iterable<StoredSentenceEnrichmentRecord>;
const exampleSentenceCoverage = summarizeExampleEnrichmentCoverage(items, readStoredExamples());
const exampleGaps = exampleSentenceCoverage.expected - exampleSentenceCoverage.fullyEnriched;
const complete = topLevel.items === 0 && exampleGaps === 0;

// Outstanding work is normal between cycles, and an image no local model can draw stays outstanding, so
// only work the cycle should already have done raises the alert.
const stall = findStalledEnrichment(items, readStoredExamples, {
  overdueAfterHours: numberFromEnv('INCREMENTAL_ENRICHMENT_STALL_HOURS', 18, 6, 168),
  imageGapTolerance: numberFromEnv('INCREMENTAL_ENRICHMENT_IMAGE_GAP_TOLERANCE', 20, 0, 100_000),
  examplesPublishedAt: (db.prepare('SELECT MAX(updated_at) AS at FROM sentence_enrichments').get() as
    { at: number | null }).at ?? 0,
});

console.log(JSON.stringify({
  mode: 'audit-only',
  prioritySince,
  complete,
  stall,
  topLevel,
  exampleGaps,
  exampleSentenceCoverage,
}));

if (stall.alerts.length > 0) process.exitCode = 1;
