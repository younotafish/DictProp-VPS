import { getAllItems } from '../db.js';
import { findStalledEnrichment } from '../enrichment-stall.js';
import {
  collectExpectedExampleSentenceHashes,
  readStoredExampleCoverage,
  summarizeExampleEnrichmentCoverage,
} from '../example-enrichment-coverage.js';
import { summarizeIncrementalEnrichmentBacklog } from '../incremental-enrichment.js';
import { storedEnrichmentRows } from './support/enrichment-rows.js';
import { requireOwner } from './support/run.js';

const HOUR_MS = 60 * 60 * 1_000;
const numberFromEnv = (name: string, fallback: number, min: number, max: number): number => {
  const requested = Number(process.env[name] || fallback);
  return Number.isFinite(requested) ? Math.max(min, Math.min(max, requested)) : fallback;
};
const lookbackHours = numberFromEnv('INCREMENTAL_ENRICHMENT_LOOKBACK_HOURS', 24, 1, 168);
const prioritySince = Date.now() - lookbackHours * HOUR_MS;

const owner = requireOwner();
const items = getAllItems(owner.id);
const topLevel = summarizeIncrementalEnrichmentBacklog(items, prioritySince);
// One pass over the stored examples serves both the coverage and the stall check, whose examples are a subset.
const storedExamples = readStoredExampleCoverage(
  storedEnrichmentRows(),
  new Set(collectExpectedExampleSentenceHashes(items)),
);
const exampleSentenceCoverage = summarizeExampleEnrichmentCoverage(items, storedExamples.coverage);
const exampleGaps = exampleSentenceCoverage.expected - exampleSentenceCoverage.fullyEnriched;
const complete = topLevel.items === 0 && exampleGaps === 0;

// Outstanding work is normal between cycles, and an image no local model can draw stays outstanding, so
// only work the cycle should already have done raises the alert.
const stall = findStalledEnrichment(items, storedExamples.coverage, {
  overdueAfterHours: numberFromEnv('INCREMENTAL_ENRICHMENT_STALL_HOURS', 18, 6, 168),
  imageGapTolerance: numberFromEnv('INCREMENTAL_ENRICHMENT_IMAGE_GAP_TOLERANCE', 20, 0, 100_000),
  examplesPublishedAt: storedExamples.latestUpdatedAt,
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
