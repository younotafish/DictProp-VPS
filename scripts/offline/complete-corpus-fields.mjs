#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeJsonAtomic } from './atomic-file.mjs';
import {
  NOTHING_SUCCEEDED_EXIT_CODE,
  ledgerFromEnvironment,
  parentHash,
  recordFailure,
  recordSuccess,
  updateLedger,
} from './failure-ledger.mjs';
import {
  batchFiles,
  batchFingerprint,
  createStageLifecycle,
  runCachedModelBatch,
  runPool,
  runSplittingBatches,
  stageSettings,
} from './model-stage.mjs';
import { resolveStructuredModel, runStructuredModel } from './structured-model.mjs';
import {
  applyCompletions,
  collectCompletionTasks,
  compactTask,
  readCompletionResults,
} from './vocab-completion.mjs';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: complete-corpus-fields.mjs <corpus-manifest> <completed-manifest> [work-directory]');
}

const MODEL_CONFIG = resolveStructuredModel();
const { model: MODEL, reasoningEffort: REASONING_EFFORT } = MODEL_CONFIG;
const { timeoutMs: MODEL_TIMEOUT_MS, retryDelayMs, concurrency } = stageSettings({ defaultTimeoutMinutes: 40 });
const lifecycle = createStageLifecycle();
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

const tasks = collectCompletionTasks(source.entries);
if (tasks.length === 0) {
  writeJsonAtomic(outputPath, source);
  process.stderr.write('No incomplete vocabulary cards found\n');
  process.exit(0);
}

const batches = [];
const batchSize = Math.max(1, Math.min(20, Number(process.env.VOCAB_COMPLETION_BATCH_SIZE || 8)));
for (let index = 0; index < tasks.length; index += batchSize) batches.push(tasks.slice(index, index + batchSize));

function filesFor(batch, batchIndex) {
  return batchFiles(workDir, batchIndex, batchFingerprint(MODEL_CONFIG, {
    instruction, schema: completionSchema, records: batch.map(compactTask),
  }));
}

function askModel({ prompt, resultPath }) {
  return runStructuredModel(MODEL_CONFIG, {
    prompt, schema: completionSchema, resultPath, timeoutMs: MODEL_TIMEOUT_MS, activeChildren: lifecycle.activeChildren,
  });
}

function runBatch(batch, batchIndex) {
  const compact = batch.map(compactTask);
  return runCachedModelBatch({
    resultPath: filesFor(batch, batchIndex).result,
    prompt: correction => `${instruction}${correction}\n\nCOMPLETE THESE CARDS:\n${JSON.stringify(compact)}`,
    correction: message => `\n\nYour previous response failed validation: ${message}. Return every itemIndex and two natural examples per item, each at least 20 characters long with exactly one target use wrapped in double curly braces.`,
    ask: askModel,
    validate: parsed => readCompletionResults(parsed, batch),
    retryDelayMs,
    splittable: batch.length > 1,
    lifecycle,
  });
}

// A batch that keeps failing is halved until the failure is pinned to single cards, so one card the
// model cannot complete no longer takes its batch-mates down with it.
function runBatchResilient(batch, batchIndex) {
  return runSplittingBatches(batch, {
    run: part => runBatch(part, batchIndex),
    markerPath: part => filesFor(part, batchIndex).splitMarker,
    marker: (part, error, depth) => ({
      version: 1,
      batchIndex,
      depth,
      cardIds: part.map(task => task.cardId),
      error,
      splitAt: new Date().toISOString(),
    }),
    onSplit: ({ batch: part, error, resumed }) => {
      if (!resumed) process.stderr.write(`Completion batch ${batchIndex + 1} failed (${error}); splitting ${part.length} cards\n`);
    },
    onSingletonFailure: (task, error) => {
      process.stderr.write(`Card ${task.cardId} of ${task.parentId} failed on its own: ${error}\n`);
      return { task, error };
    },
    lifecycle,
  });
}

const completedTasks = [];
const failures = [];
await runPool(batches.length, concurrency, lifecycle, async index => {
  process.stderr.write(`Completing corpus batch ${index + 1}/${batches.length}\n`);
  const outcome = await runBatchResilient(batches[index], index);
  completedTasks.push(...outcome.results);
  failures.push(...outcome.failures);
});

const generatedAt = Date.now();
const { entries, failedParents, checkFailures, completedCards } = applyCompletions(
  source.entries, completedTasks, failures, { model: MODEL, provider: MODEL_CONFIG.marker, generatedAt },
);
for (const { id, message } of checkFailures) {
  process.stderr.write(`Vocabulary item ${id} failed its completion check: ${message}\n`);
}

const expectedCards = tasks.filter(task => !failedParents.has(task.parentId)).length;
if (completedCards !== expectedCards) throw new Error(`Applied ${completedCards}/${expectedCards} completions`);
const failedEntries = source.entries.filter(entry => failedParents.has(entry.id));
if (failedEntries.length > 0) {
  writeJsonAtomic(failuresPath, {
    version: 1,
    generatedAt,
    provider: MODEL_CONFIG.marker,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    failures: failedEntries.map(entry => ({ id: entry.id, error: failedParents.get(entry.id) })),
  });
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
writeJsonAtomic(outputPath, output);
writeJsonAtomic(join(dirname(outputPath), 'completion-report.json'), {
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
});
process.stderr.write(`Wrote ${completedCards} completed cards to ${outputPath}${
  failedEntries.length ? `; ${failedEntries.length} item(s) deferred to a later cycle` : ''}\n`);
