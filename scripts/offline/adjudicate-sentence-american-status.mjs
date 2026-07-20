#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installCodexSignalCleanup, killCodex, spawnCodex } from './codex-process.mjs';

const [adjudicationArg, sourceArg, outputArg, workArg, existingArg, analysisArg] = process.argv.slice(2);
if (!adjudicationArg || !sourceArg || !outputArg) {
  throw new Error('Usage: adjudicate-sentence-american-status.mjs <usage-adjudication.json> <sentence-source.json> <manifest.json> [work-directory] [existing-manifest.json] [analysis.json]');
}

const MODEL = 'gpt-5.6-sol';
const activeStatuses = new Set(['modern_american', 'current_general', 'narrow_specialized']);
const activeChildren = new Set();
let aborting = false;
installCodexSignalCleanup(activeChildren, () => { aborting = true; });
const adjudication = readJson(adjudicationArg);
const source = readJson(sourceArg);
if (!Array.isArray(adjudication?.entries) || !Array.isArray(source?.sentences)) {
  throw new Error('Usage adjudication or sentence source is invalid');
}
const sourceById = new Map(source.sentences.map(sentence => [sentence.id, sentence]));
if (sourceById.size !== source.sentences.length) throw new Error('Sentence source contains duplicate ids');

const targets = [];
const targetIds = new Set();
const activeGroups = new Map();
const groupKey = (parentId, cardId) => `${parentId}\0${cardId}`;

function addTarget(group, sentence, priorAssessment) {
  targetIds.add(sentence.id);
  targets.push({
    id: sentence.id,
    textHash: sentence.textHash,
    text: sentence.text,
    word: group.decision.lexicalAction === 'correct' ? group.decision.correctedWord : group.word,
    sense: group.decision.lexicalAction === 'correct' ? group.decision.correctedSense : group.sense,
    usageStatus: group.decision.usageStatus,
    usageReason: group.decision.usageReason,
    priorAssessment,
  });
}

for (const group of adjudication.entries) {
  const usageStatus = group.decision?.usageStatus;
  if (!activeStatuses.has(usageStatus)) continue;
  activeGroups.set(groupKey(group.parentId, group.cardId), group);
  for (let index = 0; index < group.examples.length; index++) {
    if (group.decision.examples[index]?.action !== 'keep') continue;
    const example = group.examples[index];
    const sentence = sourceById.get(example.id);
    if (!sentence || sentence.text !== example.text || targetIds.has(example.id)) {
      throw new Error(`Kept adjudication has an invalid sentence identity: ${example.id}`);
    }
    addTarget(group, sentence, example.modelAssessment);
  }
}

if (analysisArg) {
  const analysis = readJson(analysisArg);
  if (!Array.isArray(analysis?.entries)) throw new Error('Final sentence analysis is invalid');
  const analysisById = new Map(analysis.entries.map(entry => [entry.id, entry]));
  if (analysisById.size !== analysis.entries.length) throw new Error('Final sentence analysis contains duplicate ids');
  for (const sentence of source.sentences) {
    const analyzed = analysisById.get(sentence.id);
    if (analyzed?.textHash !== sentence.textHash || analyzed.analysis?.americanEnglish?.status !== 'not_american') continue;
    for (const provenance of sentence.provenance || []) {
      const group = activeGroups.get(groupKey(provenance.parentId, provenance.cardId));
      if (!group) continue;
      const listedIndex = group.examples.findIndex(example => example.id === sentence.id);
      if (listedIndex >= 0 && group.decision.examples[listedIndex]?.action !== 'keep') continue;
      if (!targetIds.has(sentence.id)) {
        addTarget(group, sentence, analyzed.analysis.americanEnglish.explanation);
      }
      break;
    }
  }
}
targets.sort((left, right) => left.id.localeCompare(right.id));
if (targets.length === 0) throw new Error('No kept active-usage examples require sentence-status adjudication');

const existing = existingArg ? readJson(existingArg) : null;
if (existing && (existing.version !== 1 || !Array.isArray(existing.entries))) {
  throw new Error('Existing sentence-status adjudication is invalid');
}
const existingById = new Map((existing?.entries || []).map(entry => [entry.id, entry]));
if (existingById.size !== (existing?.entries || []).length) throw new Error('Existing sentence-status adjudication has duplicate ids');
const pending = targets.filter(target => {
  const prior = existingById.get(target.id);
  return !prior || prior.textHash !== target.textHash || prior.usageStatus !== target.usageStatus;
});

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
        required: ['itemIndex', 'status', 'explanation'],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          status: { type: 'string', enum: ['american', 'shared', 'not_american'] },
          explanation: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
      },
    },
  },
};
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'american-status-work'));
mkdirSync(workDir, { recursive: true });
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const instruction = `You are the final dialect editor for a C1/C2 American English learning app. A senior lexicographer has already decided to KEEP each supplied sentence and has adjudicated the exact sense's usage label. Resolve only the sentence-level American-English badge and explanation.

- american: distinctly American wording OR widespread informal/nonstandard American wording. Explicitly identify nonstandard grammar or register rather than hiding it.
- shared: natural current wording used across American English and other major varieties. Do not call universal wording American merely because Americans use it.
- not_american: wording that is not normal in current American English. This remains valid for a narrow_specialized item when the exact regional/specialized expression is authentically non-American.

A modern_american sense must receive american. A current_general sense must receive american or shared. A narrow_specialized sense may receive any status based on its real community and region. Reassess the complete sentence using the senior usage decision as controlling context; do not merely copy the prior conflicting assessment. Explain concrete spelling, grammar, lexicon, region, or register evidence in concise English. Return every itemIndex exactly once and only schema-valid JSON.`;

const batches = [];
for (let index = 0; index < pending.length; index += 12) batches.push(pending.slice(index, index + 12));

function compact(target, itemIndex) {
  return {
    itemIndex,
    text: target.text,
    word: target.word,
    sense: target.sense,
    adjudicatedUsageStatus: target.usageStatus,
    seniorUsageReason: target.usageReason,
    priorConflictingAssessment: target.priorAssessment,
  };
}

function validate(batch, parsed) {
  if (!Array.isArray(parsed?.results) || parsed.results.length !== batch.length) throw new Error('Wrong result count');
  const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
  if (byIndex.size !== batch.length) throw new Error('Duplicate result indexes');
  return batch.map((target, itemIndex) => {
    const result = byIndex.get(itemIndex);
    if (!result || !['american', 'shared', 'not_american'].includes(result.status) ||
        typeof result.explanation !== 'string' || !result.explanation.trim()) {
      throw new Error(`${target.id}: invalid American-English assessment`);
    }
    if (target.usageStatus === 'modern_american' && result.status !== 'american') {
      throw new Error(`${target.id}: modern American usage must be labeled american`);
    }
    if (target.usageStatus === 'current_general' && result.status === 'not_american') {
      throw new Error(`${target.id}: current general usage cannot be labeled not_american`);
    }
    return result;
  });
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
    }, 10 * 60 * 1000);
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
  const compactBatch = batch.map(compact);
  const fingerprint = createHash('sha256').update(JSON.stringify(compactBatch)).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        await runCodex([
          'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
          '-m', MODEL, '--output-schema', schemaPath, '-o', resultPath, '-',
        ], `${instruction}${correction}\n\nADJUDICATE THESE SENTENCES:\n${JSON.stringify(compactBatch)}`);
      }
      return validate(batch, readJson(resultPath));
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nThe previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Return every itemIndex and obey the usage-status constraints.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`American-status batch ${batchIndex + 1} exhausted retries`);
}

const batchResults = new Array(batches.length);
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(12, Number(process.env.CODEX_CONCURRENCY || 4)));
async function worker() {
  for (;;) {
    const batchIndex = nextBatch++;
    if (batchIndex >= batches.length) return;
    process.stderr.write(`Adjudicating American status batch ${batchIndex + 1}/${batches.length}\n`);
    batchResults[batchIndex] = await runBatch(batches[batchIndex], batchIndex);
  }
}
async function terminateChildren() {
  aborting = true;
  for (const child of activeChildren) killCodex(child, 'SIGTERM');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  for (const child of activeChildren) killCodex(child, 'SIGKILL');
}
if (batches.length > 0) {
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  } catch (error) {
    await terminateChildren();
    throw error;
  }
}

const generatedById = new Map();
for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
  for (let itemIndex = 0; itemIndex < batches[batchIndex].length; itemIndex++) {
    const target = batches[batchIndex][itemIndex];
    generatedById.set(target.id, {
      id: target.id,
      textHash: target.textHash,
      usageStatus: target.usageStatus,
      americanEnglish: {
        status: batchResults[batchIndex][itemIndex].status,
        explanation: batchResults[batchIndex][itemIndex].explanation.trim(),
      },
    });
  }
}
const entries = targets.map(target => generatedById.get(target.id) || existingById.get(target.id));
if (entries.some(entry => !entry)) throw new Error('A kept sentence has no American-English adjudication');
const generatedAt = Date.now();
writeFileSync(outputPath, `${JSON.stringify({ version: 1, generatedAt, model: MODEL, entries }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${entries.length} American-English sentence adjudications (${pending.length} generated, ${entries.length - pending.length} reused)\n`);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}
