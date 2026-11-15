#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  NOTHING_SUCCEEDED_EXIT_CODE,
  ledgerFromEnvironment,
  recordFailure,
  recordSuccess,
  sentenceHash,
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
import {
  analysisRecords,
  preservedGrammarFor,
  readAnalysisResults,
  readBaseAnalyses,
} from './sentence-analysis-checks.mjs';
import {
  DETAILED_SENTENCE_ANALYSIS_INSTRUCTION,
  detailedSentenceAnalysisSchema,
} from './sentence-analysis-contract.mjs';
import { resolveStructuredModel, runStructuredModel } from './structured-model.mjs';

const [inputArg, outputArg, workArg, baseAnalysisArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error(
    'Usage: enrich-sentences.mjs <sentence-export.json> <manifest.json> [work-directory] [base-analysis.json]',
  );
}

const MODEL_CONFIG = resolveStructuredModel();
const { model: MODEL, reasoningEffort: REASONING_EFFORT } = MODEL_CONFIG;
const deferGrammarValidation = process.env.DEFER_SENTENCE_GRAMMAR_VALIDATION === '1';
const { timeoutMs: MODEL_TIMEOUT_MS, retryDelayMs, concurrency } = stageSettings({ defaultTimeoutMinutes: 40 });
const failureLedger = ledgerFromEnvironment('sentence-analysis');
const lifecycle = createStageLifecycle();
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'analysis-work'));
mkdirSync(workDir, { recursive: true });

const source = JSON.parse(readFileSync(inputPath, 'utf8'));
if (source?.version !== 1 || !Array.isArray(source.sentences) || source.sentences.length === 0) {
  throw new Error('Sentence export is invalid or empty');
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemIndex', 'analysis'],
        properties: { itemIndex: { type: 'integer', minimum: 0 }, analysis: detailedSentenceAnalysisSchema },
      },
    },
  },
};

const instruction = `${DETAILED_SENTENCE_ANALYSIS_INSTRUCTION}

Some records include contextBefore and/or contextAfter. Use that neighboring source text only to
resolve pronouns, references, historical situation, tone, and the image scene. Analyze, translate,
transcribe, and illustrate only the target text field; never merge neighboring wording into the
target sentence or its grammar excerpts.`;

const baseAnalysisById = baseAnalysisArg
  ? readBaseAnalyses(JSON.parse(readFileSync(resolve(baseAnalysisArg), 'utf8')))
  : new Map();
const checkOptions = { baseAnalysisById, deferGrammarValidation };

const batchSize = Math.max(1, Math.min(64, Number(process.env.SENTENCE_ANALYSIS_BATCH_SIZE || 12)));
const batches = [];
for (let index = 0; index < source.sentences.length; index += batchSize) {
  batches.push(source.sentences.slice(index, index + batchSize));
}

function filesFor(batch, batchIndex) {
  return batchFiles(workDir, batchIndex, batchFingerprint(MODEL_CONFIG, {
    instruction, schema, records: analysisRecords(batch, baseAnalysisById),
  }));
}

function askModel({ prompt, resultPath }) {
  return runStructuredModel(MODEL_CONFIG, {
    prompt, schema, resultPath, timeoutMs: MODEL_TIMEOUT_MS, activeChildren: lifecycle.activeChildren,
  });
}

function runBatch(batch, index) {
  const compact = analysisRecords(batch, baseAnalysisById);
  return runCachedModelBatch({
    resultPath: filesFor(batch, index).result,
    prompt: correction => `${instruction}${correction}\n\nANALYZE THESE SENTENCES:\n${JSON.stringify(compact)}`,
    correction: message => `\n\nYour previous response failed validation: ${message}. Copy every index and return a complete, schema-valid analysis for every sentence.`,
    ask: askModel,
    validate: parsed => readAnalysisResults(parsed, batch, checkOptions),
    retryDelayMs,
    lifecycle,
  });
}

function runBatchResilient(batch, batchIndex) {
  return runSplittingBatches(batch, {
    run: part => runBatch(part, batchIndex),
    markerPath: part => filesFor(part, batchIndex).splitMarker,
    marker: (part, error, depth) => ({
      version: 1,
      batchIndex,
      depth,
      sentenceIds: part.map(sentence => sentence.id),
      error,
      splitAt: new Date().toISOString(),
    }),
    onSplit: ({ batch: part, halves: [left, right], depth }) => {
      process.stderr.write(
        `Sentence batch ${batchIndex + 1} failed after retries; splitting ${part.length} sentence(s) into ${left.length}+${right.length} at depth ${depth + 1}\n`,
      );
    },
    onSingletonFailure: (sentence, error) => {
      const failure = { id: sentence.id, textHash: sentence.textHash, error };
      process.stderr.write(`Sentence ${failure.id} failed after singleton retries: ${failure.error}\n`);
      return failure;
    },
    lifecycle,
  });
}

const generatedAt = Date.now();
const entries = [];
const batchResults = new Array(batches.length);
const failures = [];
let completedBatches = 0;
let completedSentences = 0;
const progressPath = join(workDir, 'progress.json');
const failuresPath = join(workDir, 'failures.json');
const preservedGrammarCount = source.sentences.filter(sentence => preservedGrammarFor(baseAnalysisById, sentence)).length;

function writeProgress(status) {
  const tempPath = `${progressPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({
    status,
    provider: MODEL_CONFIG.marker,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    grammarValidation: deferGrammarValidation ? 'deferred' : 'strict',
    sourceSentences: source.sentences.length,
    baseAnalyses: baseAnalysisById.size,
    preservedGrammars: preservedGrammarCount,
    completedSentences,
    failedSentences: failures.length,
    totalBatches: batches.length,
    completedBatches,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, progressPath);
}

writeProgress('running');
try {
  await runPool(batches.length, concurrency, lifecycle, async index => {
    process.stderr.write(`Analyzing sentence batch ${index + 1}/${batches.length}\n`);
    const outcome = await runBatchResilient(batches[index], index);
    batchResults[index] = outcome.results;
    failures.push(...outcome.failures);
    completedBatches++;
    completedSentences += outcome.results.length;
    writeProgress('running');
  });
} catch (error) {
  writeProgress('failed');
  throw error;
}

if (failures.length > 0) {
  const tempPath = `${failuresPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({
    version: 1,
    generatedAt: Date.now(),
    provider: MODEL_CONFIG.marker,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    failures: failures.sort((left, right) => left.id.localeCompare(right.id)),
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, failuresPath);
  // Without a ledger the caller needs every sentence, so stop here; successful batches stay cached.
  if (!failureLedger) {
    writeProgress('incomplete');
    throw new Error(
      `${failures.length} sentence analysis singleton(s) remain incomplete; see ${failuresPath}. Successful batches remain cached.`,
    );
  }
} else if (existsSync(failuresPath)) unlinkSync(failuresPath);

// A split batch returns only its successful sentences, so each result names its own source record.
for (const results of batchResults) {
  for (const { sourceRecord, analysis } of results) {
    entries.push({ id: sourceRecord.id, textHash: sourceRecord.textHash, analysis, generatedAt });
  }
}

if (failureLedger) {
  const sourceById = new Map(source.sentences.map(sentence => [sentence.id, sentence]));
  updateLedger(failureLedger.path, ledger => {
    for (const failure of failures) {
      recordFailure(ledger, failureLedger.stage, failure.id, sentenceHash(sourceById.get(failure.id)), failure.error);
    }
    for (const entry of entries) recordSuccess(ledger, failureLedger.stage, entry.id);
  });
  if (entries.length === 0) {
    writeProgress('incomplete');
    process.stderr.write(
      `No sentence analysis succeeded; ${failures.length} sentence(s) recorded in ${failureLedger.path}\n`,
    );
    process.exit(NOTHING_SUCCEEDED_EXIT_CODE);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
const outputTemp = `${outputPath}.tmp`;
writeFileSync(outputTemp, `${JSON.stringify({
  version: 1,
  generatedAt,
  provider: MODEL_CONFIG.marker,
  model: MODEL,
  reasoningEffort: REASONING_EFFORT,
  entries,
}, null, 2)}\n`, { mode: 0o600 });
renameSync(outputTemp, outputPath);
writeProgress(failures.length > 0 ? 'partial' : 'complete');
process.stderr.write(
  `Wrote ${entries.length} sentence analyses to ${outputPath}` +
  `${failures.length > 0 ? `; ${failures.length} sentence(s) deferred to a later cycle (see ${failuresPath})` : ''}\n`,
);
