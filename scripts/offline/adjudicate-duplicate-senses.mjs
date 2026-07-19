#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { killCodex, spawnCodex } from './codex-process.mjs';

const [sourceArg, reviewedArg, verificationArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !reviewedArg || !verificationArg || !outputArg) {
  throw new Error('Usage: adjudicate-duplicate-senses.mjs <source.json> <reviewed.json> <verification.json> <output.json>');
}

const readJson = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const source = readJson(sourceArg);
const reviewed = readJson(reviewedArg);
const verification = readJson(verificationArg);
if (!Array.isArray(source?.items) || !Array.isArray(reviewed?.entries) || !Array.isArray(verification?.failures)) {
  throw new Error('Source, reviewed manifest, or verification report is invalid');
}

const sourceById = new Map(source.items.map(item => [item.id, item]));
const reviewedById = new Map(reviewed.entries.map(entry => [entry.id, entry]));
const duplicatePattern = /^duplicates regenerated sense identity from ([a-f0-9-]+)$/;
const pairs = verification.failures.map(failure => {
  const canonicalId = String(failure.message || '').match(duplicatePattern)?.[1];
  if (!canonicalId) throw new Error(`Unsupported verification failure: ${failure.id}: ${failure.message}`);
  const ids = [canonicalId, failure.id];
  const cards = ids.map(id => {
    const original = sourceById.get(id);
    const regenerated = reviewedById.get(id);
    if (original?.type !== 'vocab' || regenerated?.type !== 'vocab') {
      throw new Error(`Duplicate adjudication only supports top-level vocabulary cards: ${id}`);
    }
    return {
      id,
      original: {
        word: original.data.word,
        sense: original.data.sense,
        definition: original.data.definition,
        register: original.data.register,
        examples: original.data.examples || [],
      },
      regenerated: {
        sense: regenerated.data.sense,
        definition: regenerated.data.definition,
        register: regenerated.data.register,
        examples: regenerated.data.examples || [],
        usageAudit: regenerated.data.usageAudit,
      },
    };
  });
  return { pairIndex: 0, ids, cards };
});
pairs.forEach((pair, pairIndex) => { pair.pairIndex = pairIndex; });

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      minItems: pairs.length,
      maxItems: pairs.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pairIndex', 'classification', 'survivorId', 'reason'],
        properties: {
          pairIndex: { type: 'integer', minimum: 0, maximum: Math.max(0, pairs.length - 1) },
          classification: { type: 'string', enum: ['true_duplicate', 'distinct_senses'] },
          survivorId: { type: 'string', minLength: 1, maxLength: 200 },
          reason: { type: 'string', minLength: 20, maxLength: 700 },
        },
      },
    },
  },
};

const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
const schemaPath = `${outputPath}.schema.json`;
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const prompt = `You are a senior American English lexicographer independently adjudicating possible duplicate cards in a private ESL corpus.

For every pair, decide whether the two records teach the same lexical lemma and exact meaning in contemporary American English. Classify true_duplicate when differences are merely wording, inflection, part-of-speech labeling mistakes, or redundant breadth that belongs on one card. Classify distinct_senses only when a learner genuinely benefits from studying separate meanings with a stable semantic distinction.

Do not invent a distinction to preserve two records. Conversely, do not merge causative/intransitive, literal/figurative, transitive/intransitive, or materially different register senses when the evidence actually distinguishes them. Evaluate the original and regenerated definitions and all examples. A malformed adjective or participle card under a base-form lemma is a duplicate if its content belongs in the base lemma's forms/examples rather than representing another meaning.

For a true duplicate, choose survivorId based on the clearer, more coherent original evidence; stored learning progress and examples will be merged separately. For distinct senses, survivorId must still be one of the two ids and is informational only. Give a concrete reason under 80 words. Copy pairIndex exactly and return every pair exactly once.

PAIRS:\n${JSON.stringify(pairs)}`;

await new Promise((resolvePromise, reject) => {
  const child = spawnCodex([
    'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
    '-m', 'gpt-5.6-sol', '--output-schema', schemaPath, '-o', outputPath, '-'
  ]);
  let stderr = '';
  let hardKill;
  const timeout = setTimeout(() => {
    killCodex(child, 'SIGTERM');
    hardKill = setTimeout(() => killCodex(child, 'SIGKILL'), 10_000);
  }, 20 * 60 * 1000);
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
  child.on('error', reject);
  child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    clearTimeout(hardKill);
    if (code === 0) resolvePromise();
    else reject(new Error(`Codex exited with ${code ?? signal}: ${stderr}`));
  });
  child.stdin.end(prompt);
});

const result = readJson(outputPath);
if (!Array.isArray(result?.results) || result.results.length !== pairs.length) {
  throw new Error(`Adjudicator returned ${result?.results?.length ?? 0}/${pairs.length} results`);
}
const byIndex = new Map(result.results.map(entry => [entry.pairIndex, entry]));
if (byIndex.size !== pairs.length) throw new Error('Adjudicator returned duplicate pair indexes');
for (const pair of pairs) {
  const decision = byIndex.get(pair.pairIndex);
  if (!decision || !pair.ids.includes(decision.survivorId)) {
    throw new Error(`Adjudicator returned an invalid survivor for pair ${pair.pairIndex}`);
  }
}
process.stdout.write(`${JSON.stringify({
  pairs: pairs.length,
  duplicates: result.results.filter(entry => entry.classification === 'true_duplicate').length,
  distinct: result.results.filter(entry => entry.classification === 'distinct_senses').length,
})}\n`);
