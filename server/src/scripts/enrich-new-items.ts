import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAllItems, listAllUsers, upsertItem, upsertItemImageBinary } from '../db.js';
import { env } from '../env.js';
import { generateImage } from '../image-generation.js';
import { collectImageBackfillTargets } from '../image-backfill.js';
import {
  collectIncrementalEnrichmentItems,
  hasCompleteVocabContent,
  selectReplacementVocab,
} from '../incremental-enrichment.js';
import { isOwnerUser } from '../owner-access.js';
import { generateAnalysisData } from '../routes/ai.js';
import { hasSentenceGrammarAnalysis, isSentenceAnalysis } from '../sentence-analysis.js';
import { generateSentenceAnalysis, generateSentenceGrammarAnalysis } from '../sentence-analysis-generation.js';

const HOUR_MS = 60 * 60 * 1_000;
const maxItems = Math.max(1, Math.min(50, Number(process.env.INCREMENTAL_ENRICHMENT_MAX_ITEMS || 8)));
const lookbackHours = Math.max(1, Math.min(168, Number(process.env.INCREMENTAL_ENRICHMENT_LOOKBACK_HOURS || 24)));
const statePath = join(env.DATA_DIR, 'incremental-enrichment-state.json');
const now = Date.now();

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

const candidates = collectIncrementalEnrichmentItems(getAllItems(true, owner.id), installedAt, maxItems);
const summary = { candidates: candidates.length, contentGenerated: 0, imagesGenerated: 0, failures: 0 };

for (const original of candidates) {
  let item = original;
  try {
    if (item.type === 'sentence') {
      let analysis = item.data.analysis;
      if (!isSentenceAnalysis(analysis)) {
        analysis = await generateSentenceAnalysis(String(item.data.text || ''));
      } else if (!hasSentenceGrammarAnalysis(analysis)) {
        const grammar = await generateSentenceGrammarAnalysis(
          String(item.data.text || ''),
          analysis.translation,
        );
        analysis = { ...analysis, grammar };
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
        data: { ...replacement, id: item.data.id },
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

console.log(JSON.stringify({ installedAt, ...summary }));
if (summary.failures > 0) process.exitCode = 1;
