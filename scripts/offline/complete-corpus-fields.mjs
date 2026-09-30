#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installCodexSignalCleanup, killCodex } from './codex-process.mjs';
import {
  NOTHING_SUCCEEDED_EXIT_CODE,
  ledgerFromEnvironment,
  parentHash,
  recordFailure,
  recordSuccess,
  updateLedger,
} from './failure-ledger.mjs';
import {
  hasCurrentLocalAdvancedEnrichment,
  markLocalAdvancedEnrichment,
} from './local-advanced-enrichment.mjs';
import { resolveStructuredModel, runStructuredModel } from './structured-model.mjs';
import { missingCardFields } from './vocab-card-contract.mjs';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: complete-corpus-fields.mjs <corpus-manifest> <completed-manifest> [work-directory]');
}

const MODEL_CONFIG = resolveStructuredModel();
const { model: MODEL, reasoningEffort: REASONING_EFFORT } = MODEL_CONFIG;
const requestedTimeoutMinutes = Number(process.env.CODEX_TIMEOUT_MINUTES || 40);
const MODEL_TIMEOUT_MS = (Number.isFinite(requestedTimeoutMinutes)
  ? Math.max(5, Math.min(60, requestedTimeoutMinutes))
  : 40) * 60 * 1_000;
const retryDelayMs = Math.max(0, Math.min(60_000, Number(process.env.CODEX_RETRY_DELAY_MS || 5_000)));
const REQUIRED_TEXT_FIELDS = ['sense', 'chinese', 'ipa', 'definition', 'history', 'register', 'mnemonic', 'imagePrompt'];
const activeChildren = new Set();
let aborting = false;
installCodexSignalCleanup(activeChildren, () => { aborting = true; });
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'completion-work'));
mkdirSync(workDir, { recursive: true });
const failureLedger = ledgerFromEnvironment('vocab');
const failuresPath = join(workDir, 'failures.json');

const source = JSON.parse(readFileSync(inputPath, 'utf8'));
if (source?.version !== 1 || !Array.isArray(source.entries) || source.entries.length === 0) {
  throw new Error('Corpus audit manifest is invalid or empty');
}

const wordFamilySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['word', 'pos', 'chinese'],
  properties: {
    word: { type: 'string', maxLength: 200 },
    pos: { type: 'string', maxLength: 100 },
    chinese: { type: 'string', maxLength: 500 },
  },
};
const completionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'itemIndex', 'sense', 'chinese', 'ipa', 'definition', 'forms', 'wordFamily',
          'synonyms', 'antonyms', 'confusables', 'examples', 'history', 'register',
          'mnemonic', 'imagePrompt', 'usageAudit',
        ],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          sense: { type: 'string', maxLength: 300 },
          chinese: { type: 'string', maxLength: 1_000 },
          ipa: { type: 'string', minLength: 3, maxLength: 500 },
          definition: { type: 'string', maxLength: 4_000 },
          forms: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 20 },
          wordFamily: { type: 'array', items: wordFamilySchema, maxItems: 20 },
          synonyms: { type: 'array', items: { type: 'string', maxLength: 200 }, minItems: 1, maxItems: 12 },
          antonyms: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 12 },
          confusables: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 12 },
          examples: { type: 'array', items: { type: 'string', maxLength: 1_000 }, minItems: 2, maxItems: 2 },
          history: { type: 'string', maxLength: 4_000 },
          register: { type: 'string', maxLength: 2_000 },
          mnemonic: { type: 'string', maxLength: 2_000 },
          imagePrompt: { type: 'string', minLength: 50, maxLength: 1_200 },
          usageAudit: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'reason', 'confidence'],
            properties: {
              status: {
                type: 'string',
                enum: ['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized'],
              },
              reason: { type: 'string', minLength: 1, maxLength: 1_000 },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
          },
        },
      },
    },
  },
};
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(completionSchema, null, 2)}\n`, { mode: 0o600 });

const instruction = `You are a senior American English lexicographer creating the advanced enrichment layer for vocabulary cards used by a Chinese-speaking ESL learner. Work on the EXACT supplied sense. Do not add, remove, merge, or change meanings. Some inputs contain a basic server-generated draft; produce a complete, polished replacement for the learning metadata while preserving the headword, identity, and exact sense.

For every input:
- sense: a concise unique label in the form "part of speech: distinguishing meaning". Infer it from the supplied definition, Chinese, IPA, context, image prompt, and usage audit. Do not combine distinct senses.
- chinese: a concise, context-specific Simplified Chinese equivalent.
- ipa: the complete headword or fixed expression in rhotic General American IPA, enclosed in exactly one slash pair even when the written headword contains alternatives.
- definition: a precise original English definition for this exact sense, understandable without the source sentence.
- forms: useful grammatical forms of the headword. Return an empty array when the fixed expression has no relevant inflection.
- wordFamily: genuine derived words with part of speech and Simplified Chinese. Do not invent a family for an opaque fixed expression.
- synonyms and antonyms: exact-sense matches only. Return no antonym when none is natural.
- confusables: only terms a learner could realistically confuse by spelling, sound, or meaning.
- examples: exactly two natural, modern spoken-American sentences. Each must make this exact meaning inferable and wrap the target or a natural grammatical variant in {{double curly braces}}. Use [[double square brackets]] only around a genuinely uncommon additional expression. Avoid textbook, literary, political-propaganda, or awkward wording.
- history: concise, accurate etymology and semantic development. State uncertainty rather than inventing an origin.
- register: a practical modern-American frequency/register note consistent with the supplied usage classification. For British-only, rare/dated, or specialized senses, state the limitation and normal American alternative when one exists.
- mnemonic: a short memory aid tied to this exact meaning, not a false etymology.
- imagePrompt: a production-ready prompt for one realistic photorealistic 16:9 teaching image. Make the exact sense visually inferable and prohibit visible text, logos, watermarks, illustration, animation, collage, and split screen.
- usageAudit: classify this exact sense as modern_american, current_general, british_only, rare_or_dated, or narrow_specialized; give a concise reason and high, medium, or low confidence. Formal or advanced current English is not rare merely because it is difficult.

Preserve the headword's capitalization only when it is a proper name. Use General American English. Everything must be English except chinese and wordFamily.chinese. Copy each itemIndex exactly, return every input once, and output only schema-valid JSON.`;

const tasks = [];
for (const entry of source.entries) {
  const cards = entry.type === 'vocab'
    ? [entry.data]
    : entry.type === 'phrase' && Array.isArray(entry.data?.vocabs)
      ? entry.data.vocabs
      : [];
  for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
    const card = cards[cardIndex];
    const missing = missingCardFields(card);
    const refreshAll = !hasCurrentLocalAdvancedEnrichment(card);
    if (missing.length === 0 && !refreshAll) continue;
    tasks.push({
      parentId: entry.id,
      parentType: entry.type,
      parentQuery: entry.type === 'phrase' ? entry.data.query : undefined,
      cardIndex,
      cardId: card.id || entry.id,
      missing,
      refreshAll,
      card,
    });
  }
}

if (tasks.length === 0) {
  writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write('No incomplete vocabulary cards found\n');
  process.exit(0);
}

const compactTask = (task, itemIndex) => ({
  itemIndex,
  parentType: task.parentType,
  parentQuery: task.parentQuery,
  missingFields: task.missing,
  mode: task.refreshAll ? 'advanced_rewrite' : 'repair_missing_fields',
  word: task.card.word,
  sense: task.card.sense,
  chinese: task.card.chinese,
  ipa: task.card.ipa,
  definition: task.card.definition,
  forms: task.card.forms,
  wordFamily: task.card.wordFamily,
  synonyms: task.card.synonyms,
  antonyms: task.card.antonyms,
  confusables: task.card.confusables,
  examples: task.card.examples,
  history: task.card.history,
  register: task.card.register,
  mnemonic: task.card.mnemonic,
  imagePrompt: task.card.imagePrompt,
  usageAudit: task.card.usageAudit,
});

const batches = [];
const batchSize = Math.max(1, Math.min(20, Number(process.env.VOCAB_COMPLETION_BATCH_SIZE || 8)));
for (let index = 0; index < tasks.length; index += batchSize) batches.push(tasks.slice(index, index + batchSize));

const FIELD_PROBLEMS = {
  chinese: 'chinese must be a Simplified Chinese equivalent',
  ipa: 'IPA must be one General American transcription enclosed in a single pair of slashes',
  imagePrompt: 'image prompt is missing or shorter than 50 characters',
  wordFamily: 'every wordFamily entry needs a word, a part of speech, and Simplified Chinese',
  examples: 'examples must be two sentences of at least 20 characters, each with exactly one target use in double curly braces',
  usageAudit: 'usage audit is invalid',
};

// The result is checked against the same contract the selector uses, so an accepted card is never
// selected again for the same gap.
function validateCompletion(result, task) {
  if (!result || typeof result !== 'object') throw new Error(`${task.cardId}: result is not an object`);
  const missing = missingCardFields({ ...result, word: task.card.word }, { requireAuditedAt: false });
  if (missing.length > 0) {
    throw new Error(`${task.cardId}: ${missing.map(field => FIELD_PROBLEMS[field] || `${field} is missing or too short`).join('; ')}`);
  }
  if (result.synonyms.length === 0) throw new Error(`${task.cardId}: synonyms are empty`);
}

function normalizeCompletion(result) {
  if (!result || typeof result !== 'object') return result;
  const ipa = String(result.ipa || '').trim();
  const transcriptions = ipa.match(/\/[^/\n]+\//g) || [];
  const annotations = ipa.replace(/\/[^/\n]+\//g, '').replace(/[\s;,()\[\]–—-]/g, '');
  if (transcriptions.length > 1 && !annotations) {
    return {
      ...result,
      ipa: `/${transcriptions.map(value => value.slice(1, -1).trim()).join('; ')}/`,
    };
  }
  return result;
}

function batchFingerprint(batch) {
  return createHash('sha256')
    .update(JSON.stringify({
      provider: MODEL_CONFIG.cacheKey, model: MODEL, reasoningEffort: REASONING_EFFORT, records: batch.map(compactTask),
    }))
    .digest('hex')
    .slice(0, 16);
}

async function runBatch(batch, batchIndex) {
  const compact = batch.map(compactTask);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(4, '0')}-${batchFingerprint(batch)}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        const prompt = `${instruction}${correction}\n\nCOMPLETE THESE CARDS:\n${JSON.stringify(compact)}`;
        await runStructuredModel(MODEL_CONFIG, {
          prompt, schema: completionSchema, schemaPath, resultPath, timeoutMs: MODEL_TIMEOUT_MS, activeChildren,
        });
      }
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
        throw new Error('Model returned the wrong result count');
      }
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error('Model returned duplicate item indexes');
      return batch.map((task, itemIndex) => {
        const completion = normalizeCompletion(byIndex.get(itemIndex));
        if (!completion) throw new Error(`Model omitted item index ${itemIndex}`);
        validateCompletion(completion, task);
        return { task, completion };
      });
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nYour previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Return every itemIndex and two natural examples per item, each at least 20 characters long with exactly one target use wrapped in double curly braces.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      // Exponential and jittered, so parallel workers that failed together do not retry together.
      const delay = retryDelayMs * 4 ** attempt * (0.5 + Math.random());
      await new Promise(resolvePromise => setTimeout(resolvePromise, delay));
    }
  }
  throw new Error(`Completion batch ${batchIndex + 1} exhausted retries`);
}

// A batch that keeps failing is halved until the failure is pinned to single cards, so one card the
// model cannot complete no longer takes its batch-mates down with it.
async function runBatchResilient(batch, batchIndex, depth = 0) {
  const splitMarkerPath = join(
    workDir,
    `split-${String(batchIndex + 1).padStart(4, '0')}-${batchFingerprint(batch)}.json`,
  );
  // A batch that failed on an earlier run goes straight to its halves, whose results are cached.
  if (batch.length === 1 || !existsSync(splitMarkerPath)) {
    try {
      return { results: await runBatch(batch, batchIndex), failures: [] };
    } catch (error) {
      if (aborting) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (batch.length === 1) {
        process.stderr.write(`Card ${batch[0].cardId} of ${batch[0].parentId} failed on its own: ${message}\n`);
        return { results: [], failures: [{ task: batch[0], error: message }] };
      }
      writeFileSync(splitMarkerPath, `${JSON.stringify({
        version: 1,
        batchIndex,
        depth,
        cardIds: batch.map(task => task.cardId),
        error: message,
        splitAt: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      process.stderr.write(`Completion batch ${batchIndex + 1} failed (${message}); splitting ${batch.length} cards\n`);
    }
  }
  const midpoint = Math.ceil(batch.length / 2);
  const left = await runBatchResilient(batch.slice(0, midpoint), batchIndex, depth + 1);
  const right = await runBatchResilient(batch.slice(midpoint), batchIndex, depth + 1);
  return { results: [...left.results, ...right.results], failures: [...left.failures, ...right.failures] };
}

const completedTasks = [];
const failures = [];
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(16, Number(process.env.CODEX_CONCURRENCY || 4)));
async function worker() {
  for (;;) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    process.stderr.write(`Completing corpus batch ${index + 1}/${batches.length}\n`);
    const outcome = await runBatchResilient(batches[index], index);
    completedTasks.push(...outcome.results);
    failures.push(...outcome.failures);
  }
}

async function terminateActiveChildren() {
  aborting = true;
  for (const child of activeChildren) killCodex(child, 'SIGTERM');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  for (const child of activeChildren) killCodex(child, 'SIGKILL');
}

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
} catch (error) {
  await terminateActiveChildren();
  throw error;
}

const generatedAt = Date.now();
const completionByCard = new Map();
for (const { task, completion } of completedTasks) {
  completionByCard.set(`${task.parentId}\u0000${task.cardIndex}`, completion);
}
// A parent is published whole or not at all, so one failed card holds back only its own item.
const failedParents = new Map();
for (const { task, error } of failures) {
  if (!failedParents.has(task.parentId)) failedParents.set(task.parentId, `${task.cardId}: ${error}`);
}

function withoutImageFields(value) {
  if (Array.isArray(value)) return value.map(withoutImageFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImageFields(child)]));
}

function corpusHash(data) {
  return createHash('sha256').update(JSON.stringify(withoutImageFields(data))).digest('hex');
}

function fillCard(card, completion) {
  const next = { ...card };
  const missing = new Set(missingCardFields(card));
  const refreshAll = !hasCurrentLocalAdvancedEnrichment(card);
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (refreshAll || missing.has(field)) next[field] = completion[field].trim();
  }
  for (const field of ['forms', 'wordFamily', 'synonyms', 'antonyms', 'confusables']) {
    if (refreshAll || missing.has(field)) next[field] = completion[field];
  }
  if (refreshAll || missing.has('examples')) {
    next.examples = completion.examples;
  }
  if (refreshAll || missing.has('usageAudit')) {
    next.usageAudit = { ...completion.usageAudit, auditedAt: generatedAt };
  }
  const filled = markLocalAdvancedEnrichment(next, MODEL, generatedAt, MODEL_CONFIG.marker);
  const stillMissing = missingCardFields(filled);
  if (stillMissing.length > 0) {
    throw new Error(`${card.id || card.word}: still missing ${stillMissing.join(', ')} after completion`);
  }
  return filled;
}

let completedCards = 0;
const entries = [];
for (const entry of source.entries) {
  if (failedParents.has(entry.id)) continue;
  const originalData = entry.data;
  let data = originalData;
  let appliedCards = 0;
  try {
    if (entry.type === 'vocab') {
      const completion = completionByCard.get(`${entry.id}\u00000`);
      if (completion) {
        data = fillCard(originalData, completion);
        appliedCards++;
      }
    } else if (entry.type === 'phrase' && Array.isArray(originalData.vocabs)) {
      let changed = false;
      const vocabs = originalData.vocabs.map((card, cardIndex) => {
        const completion = completionByCard.get(`${entry.id}\u0000${cardIndex}`);
        if (!completion) return card;
        changed = true;
        appliedCards++;
        return fillCard(card, completion);
      });
      if (changed) data = { ...originalData, vocabs };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Vocabulary item ${entry.id} failed its completion check: ${message}\n`);
    failedParents.set(entry.id, message);
    continue;
  }
  completedCards += appliedCards;
  const nextEntry = {
    ...entry,
    // The previous audited target is the source for this second, resumable completion pass.
    sourceHash: corpusHash(originalData),
    data,
  };
  if (entry.type === 'vocab' && data.usageAudit) {
    nextEntry.archiveForUsage = data.usageAudit.confidence !== 'low' &&
      ['british_only', 'rare_or_dated', 'narrow_specialized'].includes(data.usageAudit.status);
  }
  entries.push(nextEntry);
}

const expectedCards = tasks.filter(task => !failedParents.has(task.parentId)).length;
if (completedCards !== expectedCards) throw new Error(`Applied ${completedCards}/${expectedCards} completions`);
const failedEntries = source.entries.filter(entry => failedParents.has(entry.id));
if (failedEntries.length > 0) {
  const tempPath = `${failuresPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({
    version: 1,
    generatedAt,
    provider: MODEL_CONFIG.marker,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    failures: failedEntries.map(entry => ({ id: entry.id, error: failedParents.get(entry.id) })),
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, failuresPath);
} else if (existsSync(failuresPath)) {
  unlinkSync(failuresPath);
}
if (!failureLedger && failedEntries.length > 0) {
  throw new Error(
    `${failedEntries.length} vocabulary item(s) remain incomplete; see ${failuresPath}. Successful batches remain cached.`,
  );
}
if (failureLedger) {
  updateLedger(failureLedger.path, ledger => {
    for (const entry of source.entries) {
      if (failedParents.has(entry.id)) {
        recordFailure(ledger, failureLedger.stage, entry.id, parentHash(entry), failedParents.get(entry.id), generatedAt);
      } else {
        recordSuccess(ledger, failureLedger.stage, entry.id);
      }
    }
  }, generatedAt);
}
const progressedParents = new Set(completedTasks.map(({ task }) => task.parentId).filter(id => !failedParents.has(id)));
if (failedEntries.length > 0 && progressedParents.size === 0) {
  if (existsSync(outputPath)) unlinkSync(outputPath);
  process.stderr.write(`No vocabulary item was completed; ${failedEntries.length} failure(s) recorded in ${failureLedger.path}\n`);
  process.exit(NOTHING_SUCCEEDED_EXIT_CODE);
}
const output = {
  ...source,
  generatedAt,
  model: `${source.model}; ${MODEL} ${MODEL_CONFIG.label} advanced enrichment`,
  entries,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(dirname(outputPath), 'completion-report.json'), `${JSON.stringify({
  version: 1,
  generatedAt,
  model: MODEL,
  provider: MODEL_CONFIG.marker,
  reasoningEffort: REASONING_EFFORT,
  completedCards,
  advancedRewrites: tasks.filter(task => task.refreshAll && !failedParents.has(task.parentId)).length,
  parentItems: new Set(tasks.map(task => task.parentId).filter(id => !failedParents.has(id))).size,
  failedParents: failedEntries.map(entry => ({ id: entry.id, error: failedParents.get(entry.id) })),
  missingFieldCounts: Object.fromEntries([...new Set(tasks.flatMap(task => task.missing))]
    .sort()
    .map(field => [field, tasks.filter(task => task.missing.includes(field)).length])),
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${completedCards} completed cards to ${outputPath}${
  failedEntries.length ? `; ${failedEntries.length} item(s) deferred to a later cycle` : ''}\n`);
