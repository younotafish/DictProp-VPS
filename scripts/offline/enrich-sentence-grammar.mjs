#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installCodexSignalCleanup, killCodex, spawnCodex } from './codex-process.mjs';

const [sourceArg, analysisArg, outputArg, workArg] = process.argv.slice(2);
if (!sourceArg || !analysisArg || !outputArg) {
  throw new Error(
    'Usage: enrich-sentence-grammar.mjs <sentence-source.json> <analysis-manifest.json> <output.json> [work-directory]',
  );
}

const MODEL = process.env.CODEX_MODEL || 'gpt-5.6-sol';
const BATCH_SIZE = Math.max(1, Math.min(64, Number(process.env.GRAMMAR_BATCH_SIZE || 32)));
const requestedTimeoutMinutes = Number(process.env.CODEX_TIMEOUT_MINUTES || 40);
const CODEX_TIMEOUT_MS = (Number.isFinite(requestedTimeoutMinutes)
  ? Math.max(5, Math.min(60, requestedTimeoutMinutes))
  : 40) * 60 * 1_000;
const activeChildren = new Set();
let aborting = false;
installCodexSignalCleanup(activeChildren, () => { aborting = true; });

const sourcePath = resolve(sourceArg);
const analysisPath = resolve(analysisArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'grammar-work'));
mkdirSync(workDir, { recursive: true });

const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const manifest = JSON.parse(readFileSync(analysisPath, 'utf8'));
if (source?.version !== 1 || !Array.isArray(source.sentences) || source.sentences.length === 0) {
  throw new Error('Sentence source is invalid or empty');
}
if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
  throw new Error('Sentence analysis manifest is invalid or empty');
}

const sourceById = new Map();
for (const sentence of source.sentences) {
  if (!sentence || typeof sentence.id !== 'string' || !sentence.id ||
      typeof sentence.text !== 'string' || !sentence.text.trim() ||
      typeof sentence.textHash !== 'string' || sentence.textHash.length !== 64 ||
      sourceById.has(sentence.id)) {
    throw new Error('Sentence source contains an invalid or duplicate record');
  }
  sourceById.set(sentence.id, sentence);
}

const entriesById = new Map();
for (const entry of manifest.entries) {
  const sentence = sourceById.get(entry?.id);
  if (!sentence || entry.textHash !== sentence.textHash || !entry.analysis || entriesById.has(entry.id)) {
    throw new Error(`Analysis identity mismatch: ${String(entry?.id)}`);
  }
  entriesById.set(entry.id, entry);
}
if (entriesById.size !== sourceById.size) {
  const missing = [...sourceById.keys()].filter(id => !entriesById.has(id));
  throw new Error(`Analysis coverage mismatch: ${entriesById.size}/${sourceById.size}; missing ${missing.slice(0, 5).join(', ')}`);
}

const grammarSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['structure', 'points'],
  properties: {
    structure: { type: 'string', minLength: 1, maxLength: 4_000 },
    points: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'excerpt', 'explanation'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 300 },
          excerpt: { type: 'string', minLength: 1, maxLength: 1_000 },
          explanation: { type: 'string', minLength: 1, maxLength: 4_000 },
        },
      },
    },
  },
};
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
        required: ['itemIndex', 'grammar'],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          grammar: grammarSchema,
        },
      },
    },
  },
};
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const instruction = `You are an expert American English grammarian and an exacting coach for an advanced Chinese-speaking learner. Add only the missing grammar analysis for each supplied sentence. Do not regenerate, paraphrase, or critique any existing translation or other analysis field.

For every sentence return:
- structure: a compact but complete English map of the sentence's clauses and phrases in source order. Name the main clause and any subordinate clauses, nonfinite phrases, coordination, or ellipsis.
- points: every construction an advanced learner needs to parse the sentence correctly. Consider tense/aspect, modality, clause relationships, nonfinite and reduced clauses, reference, word order, agreement, modification, coordination, ellipsis, and information structure when relevant. Each point must have a precise grammar label, the shortest exact excerpt copied from the supplied plain sentence, and a context-specific explanation of how the form works here, what meaning or emphasis it contributes, and why it is used rather than a plausible alternative.

Use established grammatical terminology but explain it readably. Do not give generic textbook definitions. Do not pad a simple sentence with trivial observations; points may be empty only when the structure summary fully explains a genuinely simple sentence. Never emit placeholders. Copy every itemIndex exactly, return every input once, and output only schema-valid JSON.`;

const plainSentence = value => String(value || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
  .trim();
const validString = value => typeof value === 'string' && value.trim().length > 0;
const leakedPlaceholder = value => /^(?:placeholder|tbd|todo|grammar(?:\s+(?:analysis|structure|point))?)[.!]?$/i
  .test(String(value || '').trim());

function validGrammar(grammar, text) {
  if (!grammar || !validString(grammar.structure) || leakedPlaceholder(grammar.structure) ||
      !Array.isArray(grammar.points) || grammar.points.length > 12) return false;
  const seen = new Set();
  for (const point of grammar.points) {
    if (!point || !validString(point.label) || !validString(point.excerpt) ||
        !validString(point.explanation) ||
        [point.label, point.excerpt, point.explanation].some(leakedPlaceholder) ||
        !text.includes(point.excerpt)) return false;
    const key = `${point.label.trim().toLowerCase()}\0${point.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

const missing = source.sentences.filter(sentence =>
  !validGrammar(entriesById.get(sentence.id).analysis.grammar, plainSentence(sentence.text))
);
const batches = [];
for (let index = 0; index < missing.length; index += BATCH_SIZE) batches.push(missing.slice(index, index + BATCH_SIZE));

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
    }, CODEX_TIMEOUT_MS);
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

async function runBatch(batch, batchIndex) {
  const compact = batch.map((sentence, itemIndex) => ({
    itemIndex,
    text: plainSentence(sentence.text),
    sourceWord: sentence.sourceWord || '',
    sourceSense: sentence.sourceSense || '',
    existingTranslation: entriesById.get(sentence.id).analysis.translation || '',
  }));
  const fingerprint = createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(5, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        await runCodex([
          'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
          '-m', MODEL, '--output-schema', schemaPath, '-o', resultPath, '-',
        ], `${instruction}${correction}\n\nSENTENCES:\n${JSON.stringify(compact)}`);
      }
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
        throw new Error('wrong grammar result count');
      }
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error('duplicate grammar indexes');
      return batch.map((sentence, itemIndex) => {
        const result = byIndex.get(itemIndex);
        if (!result || !validGrammar(result.grammar, plainSentence(sentence.text))) {
          throw new Error(`${sentence.id}: invalid grammar analysis or non-exact excerpt`);
        }
        return { id: sentence.id, grammar: result.grammar };
      });
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nThe previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Return every sentence exactly once and copy excerpts verbatim.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`Grammar batch ${batchIndex + 1} exhausted retries`);
}

async function runBatchResilient(batch, batchIndex, depth = 0) {
  try {
    return await runBatch(batch, batchIndex);
  } catch (error) {
    if (aborting || batch.length === 1) throw error;
    const midpoint = Math.ceil(batch.length / 2);
    const left = batch.slice(0, midpoint);
    const right = batch.slice(midpoint);
    process.stderr.write(
      `Grammar batch ${batchIndex + 1} failed after retries; splitting ${batch.length} sentence(s) into ${left.length}+${right.length} at depth ${depth + 1}\n`,
    );
    return [
      ...await runBatchResilient(left, batchIndex, depth + 1),
      ...await runBatchResilient(right, batchIndex, depth + 1),
    ];
  }
}

const grammarById = new Map();
let nextBatch = 0;
let completedBatches = 0;
let completedSentences = 0;
const progressPath = join(workDir, 'progress.json');
function writeProgress(status) {
  const tempPath = `${progressPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({
    status,
    model: MODEL,
    sourceSentences: source.sentences.length,
    alreadyComplete: source.sentences.length - missing.length,
    targetSentences: missing.length,
    completedSentences,
    totalBatches: batches.length,
    completedBatches,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, progressPath);
}

async function worker() {
  for (;;) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    process.stderr.write(`Generating grammar batch ${index + 1}/${batches.length}\n`);
    const results = await runBatchResilient(batches[index], index);
    for (const result of results) grammarById.set(result.id, result.grammar);
    completedBatches++;
    completedSentences += results.length;
    writeProgress('running');
  }
}

writeProgress(missing.length === 0 ? 'complete' : 'running');
if (missing.length > 0) {
  const concurrency = Math.max(1, Math.min(64, Number(process.env.CODEX_CONCURRENCY || 20)));
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  } catch (error) {
    aborting = true;
    for (const child of activeChildren) killCodex(child, 'SIGTERM');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
    for (const child of activeChildren) killCodex(child, 'SIGKILL');
    writeProgress('failed');
    throw error;
  }
}

const generatedAt = Date.now();
const entries = manifest.entries.map(entry => {
  const grammar = grammarById.get(entry.id);
  return grammar ? {
    ...entry,
    analysis: { ...entry.analysis, grammar },
    generatedAt,
  } : entry;
});
for (const entry of entries) {
  const sentence = sourceById.get(entry.id);
  if (!validGrammar(entry.analysis.grammar, plainSentence(sentence.text))) {
    throw new Error(`${entry.id}: final grammar validation failed`);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
const outputTemp = `${outputPath}.tmp`;
writeFileSync(outputTemp, `${JSON.stringify({
  ...manifest,
  generatedAt: Math.max(Number(manifest.generatedAt || 0), generatedAt),
  entries,
}, null, 2)}\n`, { mode: 0o600 });
renameSync(outputTemp, outputPath);
writeProgress('complete');
process.stderr.write(`Wrote grammar for ${missing.length} sentence(s) to ${outputPath}\n`);
