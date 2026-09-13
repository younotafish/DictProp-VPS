import { createHash } from 'crypto';
import {
  db,
  getAllItems,
  listAllUsers,
  upsertItem,
  upsertItemImageBinary,
  upsertSentenceEnrichment,
} from '../db.js';
import { env } from '../env.js';
import {
  collectExpectedExampleSentences,
  summarizeExampleEnrichmentCoverage,
  type StoredSentenceEnrichmentRecord,
} from '../example-enrichment-coverage.js';
import { generateImage } from '../image-generation.js';
import { collectImageBackfillTargets } from '../image-backfill.js';
import {
  collectIncrementalEnrichmentItems,
  hasCompleteVocabContent,
  incrementalEnrichmentItemKey,
  selectReplacementVocab,
  selectUnattemptedIncrementalItems,
  summarizeIncrementalEnrichmentBacklog,
} from '../incremental-enrichment.js';
import { isOwnerUser } from '../owner-access.js';
import { generateAnalysisData } from '../routes/ai.js';
import {
  hasCompleteSentenceAnalysis,
  isSentenceGrammarAnalysis,
  type SentenceAnalysis,
} from '../sentence-analysis.js';
import { generateSentenceAnalysis } from '../sentence-analysis-generation.js';

const HOUR_MS = 60 * 60 * 1_000;
const boundedNumber = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};
const batchSize = boundedNumber(process.env.INCREMENTAL_ENRICHMENT_MAX_ITEMS, 8, 1, 50);
const exampleBatchSize = boundedNumber(
  process.env.INCREMENTAL_EXAMPLE_ENRICHMENT_MAX_ITEMS,
  8,
  1,
  50,
);
const lookbackHours = boundedNumber(process.env.INCREMENTAL_ENRICHMENT_LOOKBACK_HOURS, 24, 1, 168);
const maxRuntimeMinutes = boundedNumber(
  process.env.INCREMENTAL_ENRICHMENT_MAX_RUNTIME_MINUTES,
  70,
  5,
  75,
);
const now = Date.now();
const deadline = now + maxRuntimeMinutes * 60_000;
const prioritySince = now - lookbackHours * HOUR_MS;

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const attempted = new Set<string>();
const discovered = new Set<string>();
const summary = {
  candidates: 0,
  attempted: 0,
  contentGenerated: 0,
  imagesGenerated: 0,
  failures: 0,
  remaining: 0,
  recentRemaining: 0,
  historicalRemaining: 0,
  remainingByType: { sentence: 0, vocab: 0, phrase: 0 },
  remainingGaps: {
    sentenceDetailedAnalysis: 0,
    sentenceImage: 0,
    recentVocabContent: 0,
    vocabImage: 0,
    phraseImage: 0,
    nestedVocabImage: 0,
  },
  deadlineReached: false,
};

interface MonitoredSentenceEnrichmentRecord extends StoredSentenceEnrichmentRecord {
  generated_at: number;
}

const loadSentenceEnrichmentRecords = (): MonitoredSentenceEnrichmentRecord[] => [...db.prepare(`
  SELECT
    e.lookup_hash,
    e.analysis,
    e.generated_at,
    CASE WHEN b.content_hash IS NOT NULL AND b.byte_length > 0
      THEN e.image_content_hash ELSE NULL END AS image_content_hash
  FROM sentence_enrichments e
  LEFT JOIN image_blobs b ON b.content_hash = e.image_content_hash
`).iterate() as Iterable<MonitoredSentenceEnrichmentRecord>];

const completeStoredAnalysis = (
  record: MonitoredSentenceEnrichmentRecord | undefined,
): SentenceAnalysis | null => {
  if (!record) return null;
  try {
    const analysis: unknown = JSON.parse(record.analysis);
    return hasCompleteSentenceAnalysis(analysis) ? analysis : null;
  } catch {
    return null;
  }
};

drain: for (;;) {
  const pending = collectIncrementalEnrichmentItems(
    getAllItems(true, owner.id),
    prioritySince,
    Number.MAX_SAFE_INTEGER,
  );
  for (const item of pending) discovered.add(incrementalEnrichmentItemKey(item));
  const candidates = selectUnattemptedIncrementalItems(pending, attempted, batchSize);
  if (pending.length === 0 || candidates.length === 0) break;
  if (Date.now() >= deadline) {
    summary.deadlineReached = true;
    break;
  }

  for (const original of candidates) {
    if (Date.now() >= deadline) {
      summary.deadlineReached = true;
      break drain;
    }
    const candidateKey = incrementalEnrichmentItemKey(original);
    attempted.add(candidateKey);
    summary.attempted++;
    let item = original;
    try {
      if (item.type === 'sentence') {
        let analysis = item.data.analysis;
        if (!hasCompleteSentenceAnalysis(analysis)) {
          analysis = await generateSentenceAnalysis(
            String(item.data.text || ''),
            isSentenceGrammarAnalysis(analysis?.grammar) ? analysis.grammar : undefined,
          );
        }
        if (analysis !== item.data.analysis) {
          item = {
            ...item,
            data: { ...item.data, analysis, analysisGeneratedAt: Date.now() },
            updatedAt: Date.now(),
          };
          upsertItem(item, owner.id);
          summary.contentGenerated++;
        }
      } else if (item.type === 'vocab' && Number(item.savedAt) >= prioritySince &&
          !hasCompleteVocabContent(item.data)) {
        const generated = await generateAnalysisData(String(item.data.word || ''), 'batch');
        const replacement = selectReplacementVocab(item.data, generated.rawData.vocabs);
        if (!replacement) throw new Error('No matching replacement vocabulary card was generated');
        item = {
          ...item,
          data: { ...replacement, id: item.data.id, imageUrl: item.data.imageUrl },
          updatedAt: Date.now(),
        };
        upsertItem(item, owner.id);
        summary.contentGenerated++;
      }

      for (const target of collectImageBackfillTargets([item])) {
        const image = await generateImage(target.prompt, '16:9', {
          style: target.generationOptions?.style ?? (item.type === 'sentence' ? 'photorealistic' : 'icon'),
          quality: 'high',
        });
        if (!upsertItemImageBinary(target.imageId, image.data, image.mimeType, owner.id)) {
          throw new Error(`Generated image could not be stored for ${target.imageId}`);
        }
        summary.imagesGenerated++;
      }
    } catch (error) {
      summary.failures++;
      console.error(`Incremental enrichment failed for ${item?.data?.id || 'unknown'}:`, error instanceof Error ? error.message : error);
    }
  }
}

summary.candidates = discovered.size;
const itemsAfterTopLevelEnrichment = getAllItems(true, owner.id);
const remaining = summarizeIncrementalEnrichmentBacklog(itemsAfterTopLevelEnrichment, prioritySince);
summary.remaining = remaining.items;
summary.recentRemaining = remaining.recentItems;
summary.historicalRemaining = remaining.historicalItems;
summary.remainingByType = remaining.byType;
summary.remainingGaps = remaining.gaps;

const initialStoredExamples = loadSentenceEnrichmentRecords();
const initialStoredExamplesByHash = new Map(initialStoredExamples.map(record => [record.lookup_hash, record]));
const exampleCandidates = collectExpectedExampleSentences(itemsAfterTopLevelEnrichment).filter(sentence => {
  const stored = initialStoredExamplesByHash.get(sentence.lookupHash);
  return !completeStoredAnalysis(stored) || !stored?.image_content_hash;
});
const exampleEnrichment = {
  candidates: exampleCandidates.length,
  attempted: 0,
  analysesGenerated: 0,
  imagesGenerated: 0,
  failures: 0,
  remaining: exampleCandidates.length,
  deadlineReached: false,
};

for (const target of exampleCandidates.slice(0, exampleBatchSize)) {
  if (Date.now() >= deadline) {
    exampleEnrichment.deadlineReached = true;
    break;
  }
  exampleEnrichment.attempted++;
  const stored = initialStoredExamplesByHash.get(target.lookupHash);
  try {
    let analysis = completeStoredAnalysis(stored);
    const generatedAt = Math.max(Date.now(), stored?.generated_at ?? 0);
    const baseEntry = (entryAnalysis: SentenceAnalysis) => ({
      id: target.id,
      text: target.text,
      lookupHash: target.lookupHash,
      textHash: createHash('sha256').update(target.text).digest('hex'),
      analysis: entryAnalysis,
      generatedAt,
    });

    if (!analysis) {
      analysis = await generateSentenceAnalysis(target.text);
      upsertSentenceEnrichment({ entry: baseEntry(analysis) });
      exampleEnrichment.analysesGenerated++;
    }

    if (!stored?.image_content_hash) {
      const prompt = String(analysis.imagePrompt || '').trim();
      if (!prompt) throw new Error('Generated sentence analysis did not include an image prompt');
      const image = await generateImage(prompt, '16:9', { style: 'photorealistic', quality: 'high' });
      upsertSentenceEnrichment({ entry: baseEntry(analysis), image: image.data, mimeType: image.mimeType });
      exampleEnrichment.imagesGenerated++;
    }
  } catch (error) {
    exampleEnrichment.failures++;
    console.error(`Example enrichment failed for ${target.id}:`, error instanceof Error ? error.message : error);
  }
}

initialStoredExamplesByHash.clear();
initialStoredExamples.length = 0;
const storedExampleEnrichments = loadSentenceEnrichmentRecords();
const exampleSentenceCoverage = summarizeExampleEnrichmentCoverage(
  itemsAfterTopLevelEnrichment,
  storedExampleEnrichments,
);
exampleEnrichment.remaining = exampleSentenceCoverage.expected - exampleSentenceCoverage.fullyEnriched;
console.log(JSON.stringify({ prioritySince, ...summary, exampleEnrichment, exampleSentenceCoverage }));
// A successful run is a hard guarantee that its own eligible queue was drained. This catches
// malformed records that remain eligible without throwing during an attempted generation.
if (summary.failures > 0 || summary.remaining > 0 || exampleEnrichment.failures > 0) process.exitCode = 1;
