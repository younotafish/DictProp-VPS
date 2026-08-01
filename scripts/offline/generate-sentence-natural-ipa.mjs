#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { killCodex, spawnCodex } from './codex-process.mjs';
import { runClaudeStructured, runMetaStructured } from './structured-output-providers.mjs';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: generate-sentence-natural-ipa.mjs <corpus-or-sentence-export.json> <ipa-manifest.json> [work-directory]');
}

const CODEX_MODEL = process.env.IPA_CODEX_MODEL || process.env.CODEX_MODEL || 'gpt-5.6-sol';
const CLAUDE_MODEL = process.env.IPA_CLAUDE_MODEL || 'claude-opus-4-8';
const META_MODEL = process.env.IPA_META_MODEL || 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8';
const requestedTimeoutMinutes = Number(process.env.IPA_TIMEOUT_MINUTES || 30);
const PROVIDER_TIMEOUT_MS = (Number.isFinite(requestedTimeoutMinutes)
  ? Math.max(5, Math.min(60, requestedTimeoutMinutes))
  : 30) * 60 * 1_000;
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'natural-ipa-work'));
const activeChildren = new Set();
let aborting = false;
mkdirSync(workDir, { recursive: true });

function sentenceRecords(payload) {
  if (payload?.version === 1 && Array.isArray(payload.sentences)) return payload.sentences;
  if (Array.isArray(payload?.items)) {
    return payload.items
      .filter(item => item?.type === 'sentence' && !item.isDeleted)
      .map(item => {
        const data = item.data || {};
        const text = typeof data.text === 'string' ? data.text : '';
        return {
          id: data.id,
          text,
          sourceWord: typeof data.sourceWord === 'string' ? data.sourceWord : '',
          ...(typeof data.sourceSense === 'string' ? { sourceSense: data.sourceSense } : {}),
          textHash: createHash('sha256').update(text).digest('hex'),
        };
      });
  }
  throw new Error('Input must be a sentence export or an exported corpus');
}

const source = JSON.parse(readFileSync(inputPath, 'utf8'));
const sentences = sentenceRecords(source);
if (sentences.length === 0) throw new Error('Input contains no sentences');
const ids = new Set();
for (const sentence of sentences) {
  if (typeof sentence.id !== 'string' || !sentence.id || typeof sentence.text !== 'string' || !sentence.text.trim()) {
    throw new Error('Input contains an invalid sentence');
  }
  if (ids.has(sentence.id)) throw new Error(`Duplicate sentence id: ${sentence.id}`);
  ids.add(sentence.id);
  const expectedHash = createHash('sha256').update(sentence.text).digest('hex');
  if (sentence.textHash !== undefined && sentence.textHash !== expectedHash) {
    throw new Error(`Stale sentence hash: ${sentence.id}`);
  }
  sentence.textHash = expectedHash;
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
        required: ['itemIndex', 'naturalSpeechIpa'],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          naturalSpeechIpa: { type: 'string', minLength: 3, maxLength: 2_000 },
        },
      },
    },
  },
};
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const generationInstruction = `You are a senior American English phonetician. For every supplied sentence, produce one accurate, readable IPA transcription of the COMPLETE sentence as spoken fluently at a naturally fast conversational pace in mainstream rhotic General American English.

Requirements:
- Transcribe the sentence in context, including the contextually correct pronunciation of heteronyms, names, abbreviations, numbers, and contractions.
- Show normal connected-speech weak forms, vowel reduction, linking, assimilation, flapping, and common contractions where a careful native speaker naturally uses them.
- Do not give slow word-by-word dictionary forms. Do not use exaggerated casual deletion, an idiosyncratic performance, eye-dialect spelling, or a narrow regional accent.
- Preserve every meaning-bearing word. Punctuation may guide phrasing but is not spoken. The marker pairs {{ }}, [[ ]], identify learning terms and are never pronounced.
- Use genuine IPA symbols, primary/secondary stress where useful, and /ɹ/ for the American rhotic. Enclose the entire transcription in exactly one pair of forward slashes.
- Copy every itemIndex exactly, return every input exactly once, and output only schema-valid JSON.`;

const reviewInstruction = `You are the final senior reviewer for General American connected-speech IPA. Check every draft against its complete source sentence, then return a corrected transcription.

Reject and correct any omitted or added meaning-bearing word, wrong heteronym or number reading, British/non-rhotic pronunciation, spelling masquerading as IPA, misplaced stress, or implausible reduction. Preserve natural mainstream American weak forms, linking, assimilation, and flapping, but avoid theatrical over-reduction. The result must cover the complete sentence and use exactly one surrounding pair of forward slashes. Copy every itemIndex exactly and output only schema-valid JSON.`;

const stripMarkers = text => text.replace(/\{\{|\}\}|\[\[|\]\]/g, '');
const batchSize = Math.max(1, Math.min(30, Number(process.env.IPA_BATCH_SIZE || 12)));
const batches = [];
for (let index = 0; index < sentences.length; index += batchSize) batches.push(sentences.slice(index, index + batchSize));

function boundedConcurrency(value, fallback, allowZero = false) {
  const parsed = Number(value ?? fallback);
  const minimum = allowZero ? 0 : 1;
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(64, Math.floor(parsed))) : fallback;
}

const providerLimits = {
  codex: boundedConcurrency(process.env.IPA_CODEX_CONCURRENCY ?? process.env.CODEX_CONCURRENCY, 20, true),
  claude: boundedConcurrency(process.env.IPA_CLAUDE_CONCURRENCY, 0, true),
  meta: boundedConcurrency(process.env.IPA_META_CONCURRENCY, 0, true),
};
const providerModels = { codex: CODEX_MODEL, claude: CLAUDE_MODEL, meta: META_MODEL };
const enabledProviders = Object.keys(providerLimits).filter(provider => providerLimits[provider] > 0);
if (enabledProviders.length === 0) throw new Error('At least one IPA provider must have positive concurrency');

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return async function withSlot(task) {
    if (active >= limit) await new Promise(resolvePromise => waiters.push(resolvePromise));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

const providerSlots = Object.fromEntries(
  enabledProviders.map(provider => [provider, createSemaphore(providerLimits[provider])]),
);

function validateIpa(value, sentence, id) {
  if (typeof value !== 'string') throw new Error(`${id}: IPA is not a string`);
  const ipa = value.trim();
  if (!/^\/[^/\n]+\/$/.test(ipa)) throw new Error(`${id}: IPA must have exactly one surrounding slash pair`);
  if (/[\[\]{}<>`]/.test(ipa)) throw new Error(`${id}: IPA contains markup`);
  const sourceWords = stripMarkers(sentence).match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  const ipaTokens = ipa.slice(1, -1).trim().split(/\s+/).filter(Boolean);
  if (sourceWords.length >= 6 && ipaTokens.length < Math.ceil(sourceWords.length * 0.55)) {
    throw new Error(`${id}: IPA appears to omit part of the sentence`);
  }
  return ipa;
}

function runCodex(args, prompt) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCodex(args);
    activeChildren.add(child);
    let stderr = '';
    let hardKillTimeout;
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    const timeout = setTimeout(() => {
      killCodex(child, 'SIGTERM');
      hardKillTimeout = setTimeout(() => killCodex(child, 'SIGKILL'), 10_000);
    }, PROVIDER_TIMEOUT_MS);
    child.on('error', error => {
      activeChildren.delete(child);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKillTimeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex exited with ${code ?? signal}: ${stderr}`));
    });
    child.stdin.end(prompt);
  });
}

async function generateStructured(provider, prompt, resultPath) {
  await providerSlots[provider](async () => {
    if (provider === 'codex') {
      await runCodex([
        'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
        '-m', CODEX_MODEL, '--output-schema', schemaPath, '-o', resultPath, '-'
      ], prompt);
      return;
    }
    const result = provider === 'claude'
      ? await runClaudeStructured({
          prompt,
          schema,
          model: CLAUDE_MODEL,
          effort: process.env.IPA_CLAUDE_EFFORT || 'high',
          timeoutMs: PROVIDER_TIMEOUT_MS,
          activeChildren,
        })
      : await runMetaStructured({
          prompt,
          schema,
          model: META_MODEL,
          timeoutMs: PROVIDER_TIMEOUT_MS,
          activeChildren,
        });
    writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  });
}

function reviewProviderFor(draftProvider) {
  const preferences = draftProvider === 'codex'
    ? ['claude', 'meta', 'codex']
    : draftProvider === 'claude'
      ? ['codex', 'meta', 'claude']
      : ['codex', 'claude', 'meta'];
  return preferences.find(provider => enabledProviders.includes(provider));
}

async function runStage({ batch, batchIndex, stage, instruction, input, provider }) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ provider, model: providerModels[provider], stage, input }))
    .digest('hex')
    .slice(0, 16);
  const resultPath = join(workDir, `${stage}-${provider}-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        await generateStructured(
          provider,
          `${instruction}${correction}\n\nINPUT:\n${JSON.stringify(input)}`,
          resultPath,
        );
      }
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) throw new Error('Wrong result count');
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error('Duplicate sentence indexes');
      return batch.map((sentence, itemIndex) => {
        const result = byIndex.get(itemIndex);
        if (!result) throw new Error(`Missing sentence index ${itemIndex}`);
        return { itemIndex, naturalSpeechIpa: validateIpa(result.naturalSpeechIpa, sentence.text, sentence.id) };
      });
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nThe previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Return every complete transcription with the exact indexes.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`${provider} ${stage} batch ${batchIndex + 1} exhausted retries`);
}

async function runBatch(batch, batchIndex, draftProvider) {
  const sourceInput = batch.map(({ text, sourceWord, sourceSense }, itemIndex) => ({
    itemIndex,
    sentence: stripMarkers(text).trim(),
    sourceWord: sourceWord || '',
    sourceSense: sourceSense || '',
  }));
  const draft = await runStage({
    batch,
    batchIndex,
    stage: 'draft',
    instruction: generationInstruction,
    input: sourceInput,
    provider: draftProvider,
  });
  const reviewInput = sourceInput.map((sourceRecord, itemIndex) => ({
    ...sourceRecord,
    draftNaturalSpeechIpa: draft[itemIndex].naturalSpeechIpa,
  }));
  return runStage({
    batch,
    batchIndex,
    stage: 'review',
    instruction: reviewInstruction,
    input: reviewInput,
    provider: reviewProviderFor(draftProvider),
  });
}

const results = new Array(batches.length);
const draftSchedule = enabledProviders.flatMap(provider =>
  Array.from({ length: providerLimits[provider] }, () => provider)
);
const providerQueues = Object.fromEntries(enabledProviders.map(provider => [provider, []]));
for (let index = 0; index < batches.length; index++) {
  providerQueues[draftSchedule[index % draftSchedule.length]].push(index);
}
async function worker(draftProvider) {
  for (;;) {
    const index = providerQueues[draftProvider].shift();
    if (index === undefined) return;
    const reviewer = reviewProviderFor(draftProvider);
    process.stderr.write(
      `Generating natural IPA batch ${index + 1}/${batches.length} with ${draftProvider}; reviewing with ${reviewer}\n`,
    );
    results[index] = await runBatch(batches[index], index, draftProvider);
  }
}

async function terminateActiveChildren() {
  aborting = true;
  for (const child of activeChildren) killCodex(child, 'SIGTERM');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  for (const child of activeChildren) killCodex(child, 'SIGKILL');
}

try {
  const workers = enabledProviders.flatMap(provider =>
    Array.from({ length: Math.min(providerLimits[provider], providerQueues[provider].length) }, () => worker(provider))
  );
  await Promise.all(workers);
} catch (error) {
  await terminateActiveChildren();
  throw error;
}

const generatedAt = Date.now();
const entries = [];
for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
  for (let itemIndex = 0; itemIndex < batches[batchIndex].length; itemIndex++) {
    const sentence = batches[batchIndex][itemIndex];
    entries.push({
      id: sentence.id,
      textHash: sentence.textHash,
      naturalSpeechIpa: results[batchIndex][itemIndex].naturalSpeechIpa,
      generatedAt,
    });
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
const models = Object.fromEntries(enabledProviders.map(provider => [provider, providerModels[provider]]));
writeFileSync(outputPath, `${JSON.stringify({
  version: 1,
  model: `cross-reviewed:${enabledProviders.join('+')}`,
  models,
  generatedAt,
  entries,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${entries.length} reviewed sentence IPA records to ${outputPath}\n`);
