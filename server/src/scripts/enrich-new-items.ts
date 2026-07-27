import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAllItems, listAllUsers, upsertItem, upsertItemImageBinary } from '../db.js';
import { env } from '../env.js';
import { generateImage } from '../image-generation.js';
import { collectImageBackfillTargets } from '../image-backfill.js';
import {
  collectIncrementalEnrichmentItems,
  hasCompleteVocabContent,
  incrementalEnrichmentItemKey,
  selectReplacementVocab,
  selectUnattemptedIncrementalItems,
} from '../incremental-enrichment.js';
import { isOwnerUser } from '../owner-access.js';
import { generateAnalysisData } from '../routes/ai.js';
import { hasCompleteSentenceAnalysis, isSentenceGrammarAnalysis } from '../sentence-analysis.js';
import { generateSentenceAnalysis } from '../sentence-analysis-generation.js';

const HOUR_MS = 60 * 60 * 1_000;
const boundedNumber = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};
const batchSize = boundedNumber(process.env.INCREMENTAL_ENRICHMENT_MAX_ITEMS, 8, 1, 50);
const lookbackHours = boundedNumber(process.env.INCREMENTAL_ENRICHMENT_LOOKBACK_HOURS, 24, 1, 168);
const maxRuntimeMinutes = boundedNumber(
  process.env.INCREMENTAL_ENRICHMENT_MAX_RUNTIME_MINUTES,
  70,
  5,
  75,
);
const statePath = join(env.DATA_DIR, 'incremental-enrichment-state.json');
const now = Date.now();
const deadline = now + maxRuntimeMinutes * 60_000;

let installedAt = now - lookbackHours * HOUR_MS;
if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state?.version === 1 && Number.isFinite(state.installedAt) && state.installedAt > 0) {
      installedAt = state.installedAt;
    }
  } catch (error) {
    console.warn('Ignoring invalid incremental enrichment state:', error instanceof Error ? error.message : error);
  }
} else {
  writeFileSync(statePath, `${JSON.stringify({ version: 1, installedAt, createdAt: now }, null, 2)}\n`, { mode: 0o600 });
}

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
  deadlineReached: false,
};

drain: for (;;) {
  const pending = collectIncrementalEnrichmentItems(
    getAllItems(true, owner.id),
    installedAt,
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
      } else if (item.type === 'vocab' && !hasCompleteVocabContent(item.data)) {
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
summary.remaining = collectIncrementalEnrichmentItems(
  getAllItems(true, owner.id),
  installedAt,
  Number.MAX_SAFE_INTEGER,
).length;
console.log(JSON.stringify({ installedAt, ...summary }));
if (summary.failures > 0 || (summary.deadlineReached && summary.remaining > 0)) process.exitCode = 1;
