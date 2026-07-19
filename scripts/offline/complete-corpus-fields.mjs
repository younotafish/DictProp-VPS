#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { killCodex, spawnCodex } from './codex-process.mjs';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: complete-corpus-fields.mjs <corpus-manifest> <completed-manifest> [work-directory]');
}

const MODEL = 'gpt-5.6-sol';
const REQUIRED_TEXT_FIELDS = ['sense', 'definition', 'history', 'register', 'mnemonic'];
const activeChildren = new Set();
let aborting = false;
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
          'itemIndex', 'sense', 'definition', 'forms', 'wordFamily', 'synonyms', 'antonyms',
          'confusables', 'examples', 'history', 'register', 'mnemonic',
        ],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          sense: { type: 'string', maxLength: 300 },
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
- definition: a precise original English definition for this exact sense, understandable without the source sentence.
- forms: useful grammatical forms of the headword. Return an empty array when the fixed expression has no relevant inflection.
- wordFamily: genuine derived words with part of speech and Simplified Chinese. Do not invent a family for an opaque fixed expression.
- synonyms and antonyms: exact-sense matches only. Return no antonym when none is natural.
- confusables: only terms a learner could realistically confuse by spelling, sound, or meaning.
- examples: exactly two natural, modern spoken-American sentences. Each must make this exact meaning inferable and wrap the target or a natural grammatical variant in {{double curly braces}}. Use [[double square brackets]] only around a genuinely uncommon additional expression. Avoid textbook, literary, political-propaganda, or awkward wording.
- history: concise, accurate etymology and semantic development. State uncertainty rather than inventing an origin.
- register: a practical modern-American frequency/register note consistent with the supplied usage classification. For British-only, rare/dated, or specialized senses, state the limitation and normal American alternative when one exists.
- mnemonic: a short memory aid tied to this exact meaning, not a false etymology.

Preserve the headword's capitalization only when it is a proper name. Use General American English. Everything must be English except wordFamily.chinese. Copy each itemIndex exactly, return every input once, and output only schema-valid JSON.`;

function validString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function missingFields(card) {
  const missing = REQUIRED_TEXT_FIELDS.filter(field => !validString(card?.[field]));
  if (!Array.isArray(card?.examples) || card.examples.length === 0) missing.push('examples');
  return missing;
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
for (let index = 0; index < tasks.length; index += 10) batches.push(tasks.slice(index, index + 10));

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
    }, 20 * 60 * 1000);
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

function validateCompletion(result, task) {
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!validString(result?.[field])) throw new Error(`${task.cardId}: ${field} is empty`);
  }
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
}

async function runBatch(batch, batchIndex) {
  const compact = batch.map(compactTask);
  const fingerprint = createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        const prompt = `${instruction}${correction}\n\nCOMPLETE THESE CARDS:\n${JSON.stringify(compact)}`;
        await runCodex([
          'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
          '-m', MODEL, '--output-schema', schemaPath, '-o', resultPath, '-',
        ], prompt);
      }
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
        throw new Error('Model returned the wrong result count');
      }
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error('Model returned duplicate item indexes');
      return batch.map((task, itemIndex) => {
        const result = byIndex.get(itemIndex);
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
const concurrency = Math.max(1, Math.min(64, Number(process.env.CODEX_CONCURRENCY || 20)));
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
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!validString(next[field])) next[field] = completion[field].trim();
  }
  for (const field of ['forms', 'wordFamily', 'synonyms', 'antonyms', 'confusables']) {
    if (!Array.isArray(next[field])) next[field] = completion[field];
  }
  if (!Array.isArray(next.examples) || next.examples.length === 0) next.examples = completion.examples;
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
  return {
    ...entry,
    // The previous audited target is the source for this second, resumable completion pass.
    sourceHash: corpusHash(originalData),
    data,
  };
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
