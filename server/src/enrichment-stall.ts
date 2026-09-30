import {
  summarizeExampleEnrichmentCoverage,
  type StoredSentenceEnrichmentRecord,
} from './example-enrichment-coverage.js';
import { summarizeIncrementalEnrichmentBacklog } from './incremental-enrichment.js';

const HOUR_MS = 60 * 60 * 1_000;
// The local cycle completes words saved in the past week: INCREMENTAL_VOCAB_LOOKBACK_HOURS in
// scripts/offline/run-incremental-example-enrichment.sh.
const LOCAL_CYCLE_LOOKBACK_HOURS = 168;

export interface EnrichmentStallOptions {
  /** How long after an item changes the local cycle, which runs every six hours, should be done with it. */
  overdueAfterHours: number;
  /** Overdue images that raise no alert: the cycle defers an image no local model can draw, sometimes for good. */
  imageGapTolerance: number;
  /** When the local cycle last published example-sentence enrichments. */
  examplesPublishedAt?: number;
  now?: number;
}

export interface EnrichmentStall {
  overdueAfterHours: number;
  lastLocalEnrichmentAt: number;
  textGaps: number;
  imageGaps: number;
  imageGapTolerance: number;
  alerts: string[];
}

const cardsOf = (item: any): any[] => {
  if (item?.type === 'vocab') return [item.data];
  if (item?.type === 'phrase') return [item.data, ...(Array.isArray(item.data?.vocabs) ? item.data.vocabs : [])];
  return [];
};

/** The newest enrichment the local cycle has published to any item. */
function latestLocalEnrichmentAt(items: any[]): number {
  let latest = 0;
  for (const item of items) {
    if (item?.type === 'sentence') latest = Math.max(latest, Number(item.data?.analysisGeneratedAt) || 0);
    for (const card of cardsOf(item)) {
      latest = Math.max(
        latest,
        Number(card?.advancedEnrichment?.generatedAt) || 0,
        Number(card?.localImageEnrichment?.generatedAt) || 0,
      );
    }
  }
  return latest;
}

/**
 * Enrichment the local cycle should already have finished. Each item's clock starts at its last change. A
 * review restarts it too, which can only delay an alert, never raise a false one.
 */
export function findStalledEnrichment(
  items: any[],
  readStoredExamples: () => Iterable<StoredSentenceEnrichmentRecord>,
  { overdueAfterHours, imageGapTolerance, examplesPublishedAt = 0, now = Date.now() }: EnrichmentStallOptions,
): EnrichmentStall {
  const overdueBefore = now - overdueAfterHours * HOUR_MS;
  const isSettled = (item: any) =>
    Math.max(Number(item?.savedAt) || 0, Number(item?.updatedAt) || 0) < overdueBefore;
  const { gaps } = summarizeIncrementalEnrichmentBacklog(
    items.filter(isSettled),
    now - LOCAL_CYCLE_LOOKBACK_HOURS * HOUR_MS,
  );
  // Every saved sentence counts here, since a saved sentence only rules out examples that have their own analysis.
  const examples = summarizeExampleEnrichmentCoverage(
    items.filter(item => item?.type === 'sentence' || isSettled(item)),
    readStoredExamples(),
  );
  const textGaps = gaps.sentenceDetailedAnalysis + gaps.recentVocabContent + gaps.recentVocabAdvanced +
    gaps.recentNestedVocabAdvanced + examples.missingAnalysis + examples.incompleteDetailedAnalysis;
  const imageGaps = gaps.sentenceImage + gaps.recentVocabLocalImage + gaps.recentPhraseLocalImage +
    gaps.recentNestedVocabLocalImage + gaps.vocabImage + gaps.phraseImage + gaps.nestedVocabImage +
    examples.missingImage;

  const lastLocalEnrichmentAt = Math.max(latestLocalEnrichmentAt(items), examplesPublishedAt);
  const lastPublished = lastLocalEnrichmentAt > 0
    ? `it last published ${Math.round((now - lastLocalEnrichmentAt) / HOUR_MS)} h ago`
    : 'it has never published';
  const alerts: string[] = [];
  if (textGaps > 0) {
    alerts.push(`${textGaps === 1 ? '1 analysis has' : `${textGaps} analyses have`} been due for over ` +
      `${overdueAfterHours} h, so the local enrichment cycle may have stopped (${lastPublished})`);
  }
  if (imageGaps > imageGapTolerance) {
    alerts.push(`${imageGaps === 1 ? '1 image has' : `${imageGaps} images have`} been due for over ` +
      `${overdueAfterHours} h, more than the ${imageGapTolerance} that deferred subjects explain (${lastPublished})`);
  }
  return { overdueAfterHours, lastLocalEnrichmentAt, textGaps, imageGaps, imageGapTolerance, alerts };
}
