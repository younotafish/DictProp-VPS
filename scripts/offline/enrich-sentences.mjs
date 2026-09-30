#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installCodexSignalCleanup, killCodex } from './codex-process.mjs';
import {
  NOTHING_SUCCEEDED_EXIT_CODE,
  ledgerFromEnvironment,
  recordFailure,
  recordSuccess,
  sentenceHash,
  updateLedger,
} from './failure-ledger.mjs';
import {
  DETAILED_SENTENCE_ANALYSIS_INSTRUCTION,
  detailedSentenceAnalysisSchema,
  isSentenceGrammarAnalysis,
  normalizeDetailedSentenceAnalysis,
  recoverExactGrammarExcerpt,
  sentenceGrammarExcerptMatchesText,
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
const requestedTimeoutMinutes = Number(process.env.CODEX_TIMEOUT_MINUTES || 40);
const MODEL_TIMEOUT_MS = (Number.isFinite(requestedTimeoutMinutes)
  ? Math.max(5, Math.min(60, requestedTimeoutMinutes))
  : 40) * 60 * 1_000;
const retryDelayMs = Math.max(0, Math.min(60_000, Number(process.env.CODEX_RETRY_DELAY_MS || 1_000)));
const failureLedger = ledgerFromEnvironment('sentence-analysis');
const activeChildren = new Set();
let aborting = false;
installCodexSignalCleanup(activeChildren, () => { aborting = true; });
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
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const instruction = `${DETAILED_SENTENCE_ANALYSIS_INSTRUCTION}

Some records include contextBefore and/or contextAfter. Use that neighboring source text only to
resolve pronouns, references, historical situation, tone, and the image scene. Analyze, translate,
transcribe, and illustrate only the target text field; never merge neighboring wording into the
target sentence or its grammar excerpts.`;

const baseAnalysisById = new Map();
if (baseAnalysisArg) {
  const base = JSON.parse(readFileSync(resolve(baseAnalysisArg), 'utf8'));
  if (base?.version !== 1 || !Array.isArray(base.entries)) throw new Error('Base analysis manifest is invalid');
  for (const entry of base.entries) {
    if (typeof entry?.id !== 'string' || !entry.id || baseAnalysisById.has(entry.id) ||
        typeof entry.textHash !== 'string') throw new Error('Base analysis manifest has an invalid identity');
    baseAnalysisById.set(entry.id, entry);
  }
}

const batchSize = Math.max(1, Math.min(64, Number(process.env.SENTENCE_ANALYSIS_BATCH_SIZE || 12)));
const batches = [];
for (let index = 0; index < source.sentences.length; index += batchSize) {
  batches.push(source.sentences.slice(index, index + batchSize));
}

function validString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedValue(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function plainSentence(value) {
  return String(value || '')
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^\[\]]+)\]\]/g, '$1');
}

function validTermIpa(value) {
  const ipa = String(value || '').trim();
  const transcriptions = ipa.match(/\/[^/\n]+\//g) || [];
  if (transcriptions.length === 0) return false;
  const annotations = ipa.replace(/\/[^/\n]+\//g, '');
  return !annotations.includes('/') &&
    /^(?:[\s;,:()[\]\-–—]*(?:past|present|plural|singular|also|or|american|us|noun|verb|adjective|adverb|stressed|unstressed)?)*[\s;,:()[\]\-–—]*$/i.test(annotations);
}

function leakedPlaceholder(value) {
  return /^(?:placeholder|tbd|todo|(?:slow\s*ipa|fast\s*ipa|careful\s*speaker\s*guide|original\s*meaning|historical\s*evolution|image\s*prompt)(?:\s+placeholder)?)[.!]?$/i.test(String(value || '').trim());
}

function preservedGrammarFor(sourceRecord) {
  const entry = baseAnalysisById.get(sourceRecord.id);
  if (!entry || entry.textHash !== sourceRecord.textHash) return undefined;
  const grammar = entry.analysis?.grammar ?? entry.grammar;
  if (!isSentenceGrammarAnalysis(grammar)) return undefined;
  const text = plainSentence(sourceRecord.text);
  return grammar.points.every(point => sentenceGrammarExcerptMatchesText(text, point.excerpt)) ? grammar : undefined;
}

function validateAnalysis(candidate, sourceRecord) {
  const id = sourceRecord.id;
  const sentenceText = plainSentence(sourceRecord.text);
  const repairedCandidate = Array.isArray(candidate?.grammar?.points)
    ? {
        ...candidate,
        grammar: {
          ...candidate.grammar,
          points: candidate.grammar.points.map(point => ({
            ...point,
            excerpt: recoverExactGrammarExcerpt(sentenceText, point?.excerpt),
          })),
        },
      }
    : candidate;
  const analysis = normalizeDetailedSentenceAnalysis(
    repairedCandidate,
    preservedGrammarFor(sourceRecord),
    id,
  );
  if (!/^(?:yes|no)\b/i.test(analysis.americanEnglish.explanation.trim())) {
    throw new Error(`${id}: American English explanation must begin with Yes or No`);
  }
  if ([
    analysis.translation,
    analysis.americanEnglish.explanation,
    ...analysis.americanEnglish.evidence,
    analysis.pronunciation.slowIpa,
    analysis.pronunciation.fastIpa,
    analysis.pronunciation.carefulSpeakerGuide,
    ...analysis.pronunciation.fastSpeechFeatures,
    analysis.pronunciation.intonationAndChunking,
    analysis.pronunciation.keyDifference,
    analysis.imagePrompt,
  ]
    .some(leakedPlaceholder)) {
    throw new Error(`${id}: placeholder or schema field leaked into sentence analysis`);
  }
  if (leakedPlaceholder(analysis.grammar.structure)) {
    throw new Error(`${id}: placeholder leaked into grammar structure`);
  }
  if (!deferGrammarValidation) {
    const seenGrammarPoints = new Set();
    for (const point of analysis.grammar.points) {
      if (!point || !validString(point.label) || !validString(point.excerpt) ||
          !validString(point.explanation) ||
          [point.label, point.excerpt, point.explanation].some(leakedPlaceholder)) {
        throw new Error(`${id}: invalid grammar point`);
      }
      if (!sentenceGrammarExcerptMatchesText(sentenceText, point.excerpt)) {
        throw new Error(
          `${id}: grammar excerpt ${JSON.stringify(point.excerpt)} is not an exact quote from ` +
          `${JSON.stringify(sentenceText)}; preserve even awkward source wording and punctuation`,
        );
      }
      const pointKey = `${normalizedValue(point.label)}\0${point.excerpt}`;
      if (seenGrammarPoints.has(pointKey)) throw new Error(`${id}: duplicate grammar point`);
      seenGrammarPoints.add(pointKey);
    }
  }
  const seenTerms = new Set();
  for (const term of analysis.terms) {
    if (!validString(term.term) || !validString(term.chinese) || !validString(term.ipa) ||
        !validTermIpa(term.ipa) ||
        !validString(term.originalMeaning) || !validString(term.historicalEvolution) ||
        !Array.isArray(term.synonyms) || term.synonyms.length === 0 ||
        !term.synonyms.every(validString) || !Array.isArray(term.antonyms) || !term.antonyms.every(validString) ||
        !Array.isArray(term.examples) || term.examples.length < 2 || !term.examples.every(validString)) {
      throw new Error(`${id}: invalid term analysis`);
    }
    const termKey = normalizedValue(term.term);
    if (seenTerms.has(termKey)) throw new Error(`${id}: duplicate term ${term.term}`);
    seenTerms.add(termKey);
    if ([term.term, term.chinese, term.ipa, term.originalMeaning, term.historicalEvolution,
      ...term.synonyms, ...term.antonyms, ...term.examples].some(leakedPlaceholder)) {
      throw new Error(`${id}: placeholder or schema field leaked into term ${term.term}`);
    }
    const exampleKeys = term.examples.map(normalizedValue);
    if (new Set(exampleKeys).size !== exampleKeys.length) {
      throw new Error(`${id}: duplicate example for term ${term.term}`);
    }
  }
  return analysis;
}

function compactBatch(batch) {
  return batch.map((sourceRecord, itemIndex) => {
    const preservedGrammar = preservedGrammarFor(sourceRecord);
    return {
      itemIndex,
      text: plainSentence(sourceRecord.text),
      sourceWord: sourceRecord.sourceWord,
      sourceSense: sourceRecord.sourceSense,
      ...(sourceRecord.contextBefore ? { contextBefore: plainSentence(sourceRecord.contextBefore) } : {}),
      ...(sourceRecord.contextAfter ? { contextAfter: plainSentence(sourceRecord.contextAfter) } : {}),
      ...(preservedGrammar ? { preservedGrammar } : {}),
    };
  });
}

function batchFingerprint(batch) {
  return createHash('sha256')
    .update(JSON.stringify({
      provider: MODEL_CONFIG.cacheKey,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      records: compactBatch(batch),
    }))
    .digest('hex')
    .slice(0, 16);
}

async function runBatch(batch, index) {
  const compact = compactBatch(batch);
  const fingerprint = batchFingerprint(batch);
  const resultPath = join(workDir, `batch-${String(index + 1).padStart(4, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        const prompt = `${instruction}${correction}\n\nANALYZE THESE SENTENCES:\n${JSON.stringify(compact)}`;
        await runStructuredModel(MODEL_CONFIG, {
          prompt, schema, schemaPath, resultPath, timeoutMs: MODEL_TIMEOUT_MS, activeChildren,
        });
      }
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) throw new Error('Wrong analysis result count');
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error('Duplicate sentence indexes');
      return batch.map((sourceRecord, itemIndex) => {
        const result = byIndex.get(itemIndex);
        if (!result) throw new Error(`Missing sentence index ${itemIndex}`);
        return { sourceRecord, analysis: validateAnalysis(result.analysis, sourceRecord) };
      });
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nYour previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Copy every index and return a complete, schema-valid analysis for every sentence.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, retryDelayMs * (attempt + 1)));
    }
  }
  throw new Error(`Sentence batch ${index + 1} exhausted retries`);
}

async function runBatchResilient(batch, batchIndex, depth = 0) {
  const splitMarkerPath = join(
    workDir,
    `split-${String(batchIndex + 1).padStart(4, '0')}-${batchFingerprint(batch)}.json`,
  );
  try {
    if (!existsSync(splitMarkerPath)) {
      return { results: await runBatch(batch, batchIndex), failures: [] };
    }
    if (batch.length === 1) {
      unlinkSync(splitMarkerPath);
      return { results: await runBatch(batch, batchIndex), failures: [] };
    }
    else throw new Error('resuming a previously split batch');
  } catch (error) {
    if (aborting) throw error;
    if (batch.length === 1) {
      const failure = {
        id: batch[0].id,
        textHash: batch[0].textHash,
        error: error instanceof Error ? error.message : String(error),
      };
      process.stderr.write(`Sentence ${failure.id} failed after singleton retries: ${failure.error}\n`);
      return { results: [], failures: [failure] };
    }
    const midpoint = Math.ceil(batch.length / 2);
    const left = batch.slice(0, midpoint);
    const right = batch.slice(midpoint);
    if (!existsSync(splitMarkerPath)) {
      writeFileSync(splitMarkerPath, `${JSON.stringify({
        version: 1,
        batchIndex,
        depth,
        sentenceIds: batch.map(sentence => sentence.id),
        error: error instanceof Error ? error.message : String(error),
        splitAt: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
    }
    process.stderr.write(
      `Sentence batch ${batchIndex + 1} failed after retries; splitting ${batch.length} sentence(s) into ${left.length}+${right.length} at depth ${depth + 1}\n`,
    );
    const leftResult = await runBatchResilient(left, batchIndex, depth + 1);
    const rightResult = await runBatchResilient(right, batchIndex, depth + 1);
    return {
      results: [...leftResult.results, ...rightResult.results],
      failures: [...leftResult.failures, ...rightResult.failures],
    };
  }
}

const generatedAt = Date.now();
const entries = [];
const batchResults = new Array(batches.length);
const failures = [];
let nextBatch = 0;
let completedBatches = 0;
let completedSentences = 0;
const progressPath = join(workDir, 'progress.json');
const failuresPath = join(workDir, 'failures.json');
const preservedGrammarCount = source.sentences.filter(sentence => preservedGrammarFor(sentence)).length;

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

const concurrency = Math.max(1, Math.min(16, Number(process.env.CODEX_CONCURRENCY || 4)));
async function analysisWorker() {
  for (;;) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    process.stderr.write(`Analyzing sentence batch ${index + 1}/${batches.length}\n`);
    const outcome = await runBatchResilient(batches[index], index);
    batchResults[index] = outcome.results;
    failures.push(...outcome.failures);
    completedBatches++;
    completedSentences += outcome.results.length;
    writeProgress('running');
  }
}
async function terminateActiveChildren() {
  aborting = true;
  for (const child of activeChildren) killCodex(child, 'SIGTERM');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  for (const child of activeChildren) killCodex(child, 'SIGKILL');
}
writeProgress('running');
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => analysisWorker()));
} catch (error) {
  await terminateActiveChildren();
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
