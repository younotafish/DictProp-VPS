#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installCodexSignalCleanup, killCodex, spawnCodex } from './codex-process.mjs';

const [auditArg, outputArg, workArg, existingArg, eligibleSourceArg] = process.argv.slice(2);
if (!auditArg || !outputArg) {
  throw new Error('Usage: adjudicate-sentence-usage-discrepancies.mjs <cache-audit.json> <manifest.json> [work-directory] [existing-manifest.json] [eligible-source.json]');
}

const MODEL = 'gpt-5.6-sol';
const activeStatuses = new Set(['modern_american', 'current_general', 'narrow_specialized']);
const statuses = ['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized'];
const confidences = ['high', 'medium', 'low'];
const activeChildren = new Set();
let aborting = false;
installCodexSignalCleanup(activeChildren, () => { aborting = true; });

const auditPath = resolve(auditArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'usage-adjudication-work'));
mkdirSync(workDir, { recursive: true });
const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
if (audit?.version !== 1 || !Array.isArray(audit.notAmerican)) throw new Error('Cache audit is invalid');
const eligibleSource = eligibleSourceArg ? JSON.parse(readFileSync(resolve(eligibleSourceArg), 'utf8')) : null;
if (eligibleSource && !Array.isArray(eligibleSource.sentences)) throw new Error('Eligible sentence source is invalid');
const eligibleIds = eligibleSource ? new Set(eligibleSource.sentences.map(sentence => sentence.id)) : null;
const eligibleGroupKeys = eligibleSource
  ? new Set(eligibleSource.sentences.flatMap(sentence =>
    (sentence.provenance || []).map(provenance => `${provenance.parentId}\0${provenance.cardId}`)))
  : null;

const grouped = new Map();
for (const entry of audit.notAmerican) {
  if (eligibleIds && !eligibleIds.has(entry.id)) continue;
  const relevant = (entry.provenance || []).filter(provenance => activeStatuses.has(provenance.usageStatus));
  if (relevant.length === 0) continue;
  if (relevant.length !== 1) throw new Error(`${entry.id}: expected one active provenance, found ${relevant.length}`);
  const provenance = relevant[0];
  const key = `${provenance.parentId}\0${provenance.cardId}`;
  let group = grouped.get(key);
  if (!group) {
    group = {
      parentId: provenance.parentId,
      parentType: provenance.parentType,
      cardId: provenance.cardId,
      cardIndex: provenance.cardIndex,
      word: provenance.word,
      sense: provenance.sense,
      currentUsageStatus: provenance.usageStatus,
      archived: provenance.archived === true,
      examples: [],
    };
    grouped.set(key, group);
  } else if (group.word !== provenance.word || group.sense !== provenance.sense ||
      group.currentUsageStatus !== provenance.usageStatus) {
    throw new Error(`${entry.id}: inconsistent provenance for ${key}`);
  }
  group.examples.push({
    id: entry.id,
    text: entry.text,
    sourceWord: entry.sourceWord,
    sourceSense: entry.sourceSense,
    modelAssessment: entry.explanation,
  });
}

const groups = [...grouped.values()].sort((left, right) =>
  left.parentId.localeCompare(right.parentId) || left.cardId.localeCompare(right.cardId));
if (groups.length === 0) throw new Error('No active-usage discrepancies require adjudication');
const groupKey = group => `${group.parentId}\0${group.cardId}`;
const existing = existingArg ? JSON.parse(readFileSync(resolve(existingArg), 'utf8')) : null;
if (existing && (existing.version !== 1 || !Array.isArray(existing.entries))) {
  throw new Error('Existing adjudication manifest is invalid');
}
const existingByKey = new Map();
for (const entry of existing?.entries || []) {
  const key = groupKey(entry);
  if (existingByKey.has(key) || !entry.decision || !Array.isArray(entry.examples)) {
    throw new Error(`Existing adjudication contains an invalid or duplicate group: ${key}`);
  }
  existingByKey.set(key, entry);
}
const sameExampleSet = (left, right) => {
  const leftIds = left.examples.map(example => example.id).sort();
  const rightIds = right.examples.map(example => example.id).sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
};
const pendingGroups = groups.filter(group => {
  const prior = existingByKey.get(groupKey(group));
  return !prior || prior.word !== group.word || prior.sense !== group.sense ||
    prior.currentUsageStatus !== group.currentUsageStatus || !sameExampleSet(prior, group);
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
        required: [
          'itemIndex', 'lexicalAction', 'correctedWord', 'correctedSense', 'correctedForms',
          'usageStatus', 'usageReason', 'confidence', 'examples',
        ],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          lexicalAction: { type: 'string', enum: ['keep', 'correct'] },
          correctedWord: { type: 'string', maxLength: 300 },
          correctedSense: { type: 'string', maxLength: 1_000 },
          correctedForms: { type: 'array', items: { type: 'string' }, maxItems: 16 },
          usageStatus: { type: 'string', enum: statuses },
          usageReason: { type: 'string', minLength: 1, maxLength: 700 },
          confidence: { type: 'string', enum: confidences },
          examples: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['exampleIndex', 'action', 'replacement', 'reason'],
              properties: {
                exampleIndex: { type: 'integer', minimum: 0 },
                action: { type: 'string', enum: ['keep', 'rewrite', 'remove'] },
                replacement: { type: 'string', maxLength: 2_000 },
                reason: { type: 'string', minLength: 1, maxLength: 500 },
              },
            },
          },
        },
      },
    },
  },
};
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const instruction = `You are the final senior American English lexicographer adjudicating conflicts in a private C1/C2 ESL corpus. A prior card audit labeled each exact sense active, general, or specialized, while a separate sentence analysis judged one or more UNSAVED examples non-American. Resolve the conflict from first principles. Do not automatically agree with either pass.

Classify the exact sense as one of:
- modern_american: normal and useful in current American English, including widespread informal or explicitly nonstandard American usage.
- current_general: normal current English shared by the United States and other major varieties.
- british_only: this exact sense or form is British/Commonwealth and not normal current American usage.
- rare_or_dated: obsolete, archaic, literary-only, or too infrequent to deserve normal learner attention.
- narrow_specialized: current but confined mainly to a profession, technical field, region, or subculture.

Use lexicalAction=correct only when the stored headword itself has an objectively wrong canonical spelling/form or the stored sense label needs a narrowly scoped correction. Supply the complete corrected headword, sense, and inflected forms. Do not use it merely to replace a British term with a different American word: keep the authentic term and label it british_only instead.

For every supplied unsaved example:
- keep it when it naturally and accurately demonstrates the exact labeled sense. Current specialized, regional, and widespread nonstandard American examples may be kept with honest labels.
- rewrite it when the sense is valid but its spelling, grammar, collocation, incidental vocabulary, or context is unnatural or misleading. A rewrite must preserve the exact sense, use the corrected headword when applicable, sound authentic for the labeled variety/register, contain one {{studied target}} marker, retain only genuinely useful [[C1/C2 lookup expressions]], and remain one self-contained sentence.
- remove it only when it duplicates another example or no honest sentence can demonstrate the exact sense.

Do not Americanize an intentionally British, historical, regional, or specialized sense; label it accurately and keep or improve an authentic contextual example. Conversely, do not preserve bad English merely to keep the current label. The input examples are not saved sentence records, so rewriting one cannot alter a saved sentence. Reasons must be concrete and concise. Return every itemIndex and exampleIndex exactly once, and output only schema-valid JSON.`;

const batches = [];
for (let index = 0; index < pendingGroups.length; index += 8) batches.push(pendingGroups.slice(index, index + 8));

const normalizedSentence = value => String(value || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();
const validString = value => typeof value === 'string' && value.trim().length > 0;

function compactGroup(group, itemIndex) {
  return {
    itemIndex,
    word: group.word,
    sense: group.sense,
    currentUsageStatus: group.currentUsageStatus,
    currentlyArchivedForUsage: group.archived,
    examples: group.examples.map((example, exampleIndex) => ({
      exampleIndex,
      text: example.text,
      separateSentenceAssessment: example.modelAssessment,
    })),
  };
}

function validateBatch(batch, parsed) {
  if (!Array.isArray(parsed?.results) || parsed.results.length !== batch.length) {
    throw new Error('Wrong adjudication result count');
  }
  const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
  if (byIndex.size !== batch.length) throw new Error('Duplicate adjudication indexes');
  return batch.map((group, itemIndex) => {
    const result = byIndex.get(itemIndex);
    if (!result) throw new Error(`Missing adjudication index ${itemIndex}`);
    if (!statuses.includes(result.usageStatus) || !confidences.includes(result.confidence) ||
        !validString(result.usageReason) || !['keep', 'correct'].includes(result.lexicalAction)) {
      throw new Error(`${group.cardId}: invalid lexical decision`);
    }
    if (result.lexicalAction === 'correct') {
      if (!validString(result.correctedWord) || !validString(result.correctedSense) ||
          !Array.isArray(result.correctedForms) || !result.correctedForms.every(validString)) {
        throw new Error(`${group.cardId}: incomplete lexical correction`);
      }
    } else if (result.correctedWord !== '' || result.correctedSense !== '' ||
        !Array.isArray(result.correctedForms) || result.correctedForms.length !== 0) {
      throw new Error(`${group.cardId}: keep decision must not include lexical corrections`);
    }
    if (!Array.isArray(result.examples) || result.examples.length !== group.examples.length) {
      throw new Error(`${group.cardId}: wrong example decision count`);
    }
    const exampleByIndex = new Map(result.examples.map(example => [example.exampleIndex, example]));
    if (exampleByIndex.size !== group.examples.length) throw new Error(`${group.cardId}: duplicate example indexes`);
    const examples = group.examples.map((example, exampleIndex) => {
      const decision = exampleByIndex.get(exampleIndex);
      if (!decision || !['keep', 'rewrite', 'remove'].includes(decision.action) || !validString(decision.reason)) {
        throw new Error(`${group.cardId}: invalid example decision ${exampleIndex}`);
      }
      if (decision.action === 'rewrite') {
        const replacement = decision.replacement.trim();
        if (!validString(replacement) || (replacement.match(/\{\{[^{}]+\}\}/g) || []).length !== 1 ||
            normalizedSentence(replacement) === normalizedSentence(example.text)) {
          throw new Error(`${group.cardId}: invalid example rewrite ${exampleIndex}`);
        }
      } else if (decision.replacement !== '') {
        throw new Error(`${group.cardId}: non-rewrite example must have an empty replacement`);
      }
      return decision;
    });
    return { ...result, examples };
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
  const compact = batch.map(compactGroup);
  const fingerprint = createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        await runCodex([
          'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
          '-m', MODEL, '--output-schema', schemaPath, '-o', resultPath, '-',
        ], `${instruction}${correction}\n\nADJUDICATE THESE CARD GROUPS:\n${JSON.stringify(compact)}`);
      }
      return validateBatch(batch, JSON.parse(readFileSync(resultPath, 'utf8')));
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nThe previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Return every identity and obey the empty-field and markup rules exactly.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`Adjudication batch ${batchIndex + 1} exhausted retries`);
}

const batchResults = new Array(batches.length);
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(16, Number(process.env.CODEX_CONCURRENCY || 4)));
async function worker() {
  for (;;) {
    const batchIndex = nextBatch++;
    if (batchIndex >= batches.length) return;
    process.stderr.write(`Adjudicating usage batch ${batchIndex + 1}/${batches.length}\n`);
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

const generatedAt = Date.now();
const generatedByKey = new Map();
for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
  for (let itemIndex = 0; itemIndex < batches[batchIndex].length; itemIndex++) {
    const entry = {
      ...batches[batchIndex][itemIndex],
      decision: batchResults[batchIndex][itemIndex],
      adjudicatedAt: generatedAt,
    };
    generatedByKey.set(groupKey(entry), entry);
  }
}
const currentEntries = groups.map(group => {
  const generated = generatedByKey.get(groupKey(group));
  if (generated) return generated;
  const prior = existingByKey.get(groupKey(group));
  return prior ? { ...prior, adjudicatedAt: Number(prior.adjudicatedAt || existing.generatedAt) } : null;
});
if (currentEntries.some(entry => !entry)) throw new Error('A current discrepancy group has no adjudication');
const entriesByKey = new Map();
for (const entry of existing?.entries || []) {
  if (!eligibleGroupKeys || eligibleGroupKeys.has(groupKey(entry))) {
    entriesByKey.set(groupKey(entry), {
      ...entry,
      adjudicatedAt: Number(entry.adjudicatedAt || existing.generatedAt),
    });
  }
}
for (const entry of currentEntries) entriesByKey.set(groupKey(entry), entry);
const entries = [...entriesByKey.values()].sort((left, right) =>
  left.parentId.localeCompare(right.parentId) || left.cardId.localeCompare(right.cardId));
writeFileSync(outputPath, `${JSON.stringify({ version: 1, generatedAt, model: MODEL, entries }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${entries.length} usage discrepancy adjudications (${pendingGroups.length} generated, ${currentEntries.length - pendingGroups.length} current reused, ${entries.length - currentEntries.length} retained) to ${outputPath}\n`);
