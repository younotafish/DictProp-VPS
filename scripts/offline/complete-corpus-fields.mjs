#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installCodexSignalCleanup, killCodex } from './codex-process.mjs';
import { createLocalMlxClient, extractJsonObject } from './local-mlx-client.mjs';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: complete-corpus-fields.mjs <corpus-manifest> <completed-manifest> [work-directory]');
}

const MODEL = process.env.LOCAL_MLX_MODEL_ID || 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit';
const REQUIRED_TEXT_FIELDS = ['sense', 'chinese', 'ipa', 'definition', 'history', 'register', 'mnemonic', 'imagePrompt'];
const activeChildren = new Set();
let aborting = false;
let localClient;
installCodexSignalCleanup(activeChildren, () => { aborting = true; });
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'completion-work'));
mkdirSync(workDir, { recursive: true });

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

const instruction = `You are a senior American English lexicographer completing structurally incomplete legacy vocabulary cards for an advanced Chinese-speaking ESL learner. Work on the EXACT supplied sense. Do not add, remove, merge, or change meanings, and do not replace any existing field in the application; your output is used only where a field is absent.

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

function validString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function missingFields(card) {
  const missing = [];
  for (const [field, minimum] of [
    ['sense', 3], ['chinese', 1], ['definition', 10], ['history', 20],
    ['register', 10], ['mnemonic', 10], ['imagePrompt', 50],
  ]) {
    if (!validString(card?.[field]) || card[field].trim().length < minimum) missing.push(field);
  }
  if (validString(card?.chinese) && !/[\u3400-\u9fff]/u.test(card.chinese)) missing.push('chinese');
  if (!/^\/[^/\n]+\/$/.test(String(card?.ipa || '').trim())) missing.push('ipa');
  for (const field of ['forms', 'synonyms', 'antonyms', 'confusables']) {
    if (!Array.isArray(card?.[field]) || card[field].some(value => !validString(value))) missing.push(field);
  }
  if (!Array.isArray(card?.wordFamily) || card.wordFamily.some(member =>
    !validString(member?.word) || !validString(member?.pos) ||
    !validString(member?.chinese) || !/[\u3400-\u9fff]/u.test(member.chinese))) {
    missing.push('wordFamily');
  }
  if (!Array.isArray(card?.examples) || card.examples.length !== 2 ||
      card.examples.some(example => !validString(example) || !/\{\{[^{}]+\}\}/.test(example))) {
    missing.push('examples');
  }
  if (!card?.usageAudit || !['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized']
    .includes(card.usageAudit.status) || !validString(card.usageAudit.reason) ||
    !['high', 'medium', 'low'].includes(card.usageAudit.confidence)) {
    missing.push('usageAudit');
  }
  return [...new Set(missing)];
}

const tasks = [];
for (const entry of source.entries) {
  const cards = entry.type === 'vocab'
    ? [entry.data]
    : entry.type === 'phrase' && Array.isArray(entry.data?.vocabs)
      ? entry.data.vocabs
      : [];
  for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
    const card = cards[cardIndex];
    const missing = missingFields(card);
    if (missing.length === 0) continue;
    tasks.push({
      parentId: entry.id,
      parentType: entry.type,
      parentQuery: entry.type === 'phrase' ? entry.data.query : undefined,
      cardIndex,
      cardId: card.id || entry.id,
      missing,
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
const batchSize = Math.max(1, Math.min(4, Number(process.env.LOCAL_MLX_VOCAB_BATCH_SIZE || 1)));
for (let index = 0; index < tasks.length; index += batchSize) batches.push(tasks.slice(index, index + batchSize));

function getLocalClient() {
  localClient ??= createLocalMlxClient({ timeoutMs: 30 * 60 * 1_000, activeChildren });
  return localClient;
}

function validateCompletion(result, task) {
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!validString(result?.[field])) throw new Error(`${task.cardId}: ${field} is empty`);
  }
  if (!/^\/[^/\n]+\/$/.test(result.ipa.trim())) throw new Error(`${task.cardId}: IPA is invalid`);
  if (!/[\u3400-\u9fff]/u.test(result.chinese)) throw new Error(`${task.cardId}: Chinese translation is invalid`);
  if (result.imagePrompt.trim().length < 50) throw new Error(`${task.cardId}: image prompt is too short`);
  for (const field of ['forms', 'wordFamily', 'synonyms', 'antonyms', 'confusables', 'examples']) {
    if (!Array.isArray(result?.[field])) throw new Error(`${task.cardId}: ${field} is not an array`);
  }
  if (result.synonyms.length === 0) throw new Error(`${task.cardId}: synonyms are empty`);
  if (result.examples.length !== 2 || result.examples.some(example => !validString(example) || !example.includes('{{'))) {
    throw new Error(`${task.cardId}: examples must contain two marked target uses`);
  }
  for (const member of result.wordFamily) {
    if (!validString(member?.word) || !validString(member?.pos) || !validString(member?.chinese)) {
      throw new Error(`${task.cardId}: wordFamily entry is incomplete`);
    }
  }
  if (!result.usageAudit ||
      !['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized']
        .includes(result.usageAudit.status) ||
      !validString(result.usageAudit.reason) ||
      !['high', 'medium', 'low'].includes(result.usageAudit.confidence)) {
    throw new Error(`${task.cardId}: usage audit is invalid`);
  }
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

async function runBatch(batch, batchIndex) {
  const compact = batch.map(compactTask);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ provider: 'local-mlx-v1', model: MODEL, records: compact }))
    .digest('hex')
    .slice(0, 16);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        const prompt = `${instruction}${correction}\n\nCOMPLETE THESE CARDS:\n${JSON.stringify(compact)}`;
        const response = await getLocalClient().generate(
          `${prompt}\n\nOUTPUT JSON SCHEMA:\n${JSON.stringify(completionSchema)}`,
          { maxTokens: 8_192, temperature: attempt === 0 ? 0 : 0.15 },
        );
        writeFileSync(resultPath, `${JSON.stringify(extractJsonObject(response))}\n`, { mode: 0o600 });
      }
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
        throw new Error('Model returned the wrong result count');
      }
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error('Model returned duplicate item indexes');
      return batch.map((task, itemIndex) => {
        const result = normalizeCompletion(byIndex.get(itemIndex));
        if (!result) throw new Error(`Model omitted item index ${itemIndex}`);
        validateCompletion(result, task);
        return result;
      });
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nYour previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Return every itemIndex and two natural examples per item, each with the target wrapped in double curly braces.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`Completion batch ${batchIndex + 1} exhausted retries`);
}

const batchResults = new Array(batches.length);
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(2, Number(process.env.LOCAL_MLX_CONCURRENCY || 1)));
async function worker() {
  for (;;) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    process.stderr.write(`Completing corpus batch ${index + 1}/${batches.length}\n`);
    batchResults[index] = await runBatch(batches[index], index);
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
await localClient?.close();

const completionByCard = new Map();
for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
  for (let itemIndex = 0; itemIndex < batches[batchIndex].length; itemIndex++) {
    const task = batches[batchIndex][itemIndex];
    completionByCard.set(`${task.parentId}\u0000${task.cardIndex}`, batchResults[batchIndex][itemIndex]);
  }
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
  const missing = new Set(missingFields(card));
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (missing.has(field)) next[field] = completion[field].trim();
  }
  for (const field of ['forms', 'wordFamily', 'synonyms', 'antonyms', 'confusables']) {
    if (missing.has(field)) next[field] = completion[field];
  }
  if (missing.has('examples')) {
    next.examples = completion.examples;
  }
  if (missing.has('usageAudit')) {
    next.usageAudit = { ...completion.usageAudit, auditedAt: Date.now() };
  }
  return next;
}

let completedCards = 0;
const entries = source.entries.map(entry => {
  const originalData = entry.data;
  let data = originalData;
  if (entry.type === 'vocab') {
    const completion = completionByCard.get(`${entry.id}\u00000`);
    if (completion) {
      data = fillCard(originalData, completion);
      completedCards++;
    }
  } else if (entry.type === 'phrase' && Array.isArray(originalData.vocabs)) {
    let changed = false;
    const vocabs = originalData.vocabs.map((card, cardIndex) => {
      const completion = completionByCard.get(`${entry.id}\u0000${cardIndex}`);
      if (!completion) return card;
      changed = true;
      completedCards++;
      return fillCard(card, completion);
    });
    if (changed) data = { ...originalData, vocabs };
  }
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
  return nextEntry;
});

if (completedCards !== tasks.length) throw new Error(`Applied ${completedCards}/${tasks.length} completions`);
const generatedAt = Date.now();
const output = {
  ...source,
  generatedAt,
  model: `${source.model}; ${MODEL} missing-field completion`,
  entries,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(dirname(outputPath), 'completion-report.json'), `${JSON.stringify({
  version: 1,
  generatedAt,
  model: MODEL,
  completedCards,
  parentItems: new Set(tasks.map(task => task.parentId)).size,
  missingFieldCounts: Object.fromEntries([...new Set(tasks.flatMap(task => task.missing))]
    .sort()
    .map(field => [field, tasks.filter(task => task.missing.includes(field)).length])),
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${completedCards} completed cards to ${outputPath}\n`);
