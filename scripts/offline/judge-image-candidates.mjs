#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [targetsArg, candidatesArg, imagesArg, workArg] = process.argv.slice(2);
if (!targetsArg || !candidatesArg || !imagesArg || !workArg) {
  throw new Error('Usage: judge-image-candidates.mjs <targets.json> <candidate-directory> <image-directory> <work-directory>');
}

const MODEL = 'gpt-5.6-sol';
const payload = JSON.parse(readFileSync(resolve(targetsArg), 'utf8'));
if (!Array.isArray(payload.targets) || payload.targets.length === 0) throw new Error('Target manifest is invalid or empty');
const candidateDir = resolve(candidatesArg);
const imageDir = resolve(imagesArg);
const workDir = resolve(workArg);
mkdirSync(imageDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

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
        required: ['itemIndex', 'acceptable', 'reason'],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          acceptable: { type: 'boolean' },
          reason: { type: 'string', maxLength: 400 },
        },
      },
    },
  },
};
const schemaPath = join(workDir, 'judgment-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const pending = payload.targets.filter(target => !existsSync(join(imageDir, target.filename)));
const batches = [];
for (let index = 0; index < pending.length; index += 8) batches.push(pending.slice(index, index + 8));

function runCodex(args, prompt) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/usr/local/bin/codex', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30 * 60 * 1000);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex exited with ${code ?? signal}: ${stderr}`));
    });
    child.stdin.end(prompt);
  });
}

async function judgeBatch(batch, batchIndex) {
  const records = batch.map((target, itemIndex) => ({ itemIndex, learningTarget: target.learningTarget, brief: target.prompt }));
  const fingerprint = createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
  const candidates = batch.map(target => join(candidateDir, `${target.filename.replace(/\.[^.]+$/, '')}-1.jpg`));
  if (candidates.some(path => !existsSync(path))) throw new Error(`Batch ${batchIndex + 1} is missing a candidate image`);
  if (!existsSync(resultPath)) {
    const prompt = `Act as a strict visual editor for an American English learning app. Each attached image corresponds, in attachment order, to the itemIndex record below:\n${JSON.stringify(records)}\n\nJudge each image independently. Accept only when it directly and unambiguously communicates the EXACT contextual meaning. Semantic correctness outweighs beauty. Check realism, anatomy and object coherence, the defining action/relationship, lack of unintended text or logos, and useful 16:9 composition. Reject generic topical stock imagery, misleading literal depictions of figurative language, decorative symbolism, animation, illustration, or omission of a defining detail. A minor cosmetic flaw is not enough to reject an otherwise accurate teaching image. Copy every itemIndex exactly and return only schema-valid JSON.`;
    await runCodex([
      'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check', '-m', MODEL,
      ...candidates.flatMap(path => ['-i', path]),
      '--output-schema', schemaPath, '-o', resultPath, '-',
    ], prompt);
  }
  const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
  if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) throw new Error(`Batch ${batchIndex + 1} returned the wrong result count`);
  const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
  if (byIndex.size !== batch.length) throw new Error(`Batch ${batchIndex + 1} returned duplicate indexes`);
  return batch.map((target, itemIndex) => {
    const result = byIndex.get(itemIndex);
    if (!result || typeof result.acceptable !== 'boolean') throw new Error(`Batch ${batchIndex + 1} omitted index ${itemIndex}`);
    return { target, result, candidate: candidates[itemIndex] };
  });
}

const results = new Array(batches.length);
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(16, Number(process.env.CODEX_CONCURRENCY || 8)));
async function worker() {
  for (;;) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    process.stderr.write(`Judging image batch ${index + 1}/${batches.length}\n`);
    results[index] = await judgeBatch(batches[index], index);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));

const rejected = [];
for (const batch of results) {
  for (const { target, result, candidate } of batch) {
    if (result.acceptable) copyFileSync(candidate, join(imageDir, target.filename));
    else rejected.push({ ...target, rejectionReason: result.reason });
  }
}
writeFileSync(join(workDir, 'rejected-targets.json'), `${JSON.stringify({ ...payload, targets: rejected }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Accepted ${pending.length - rejected.length}/${pending.length}; rejected ${rejected.length}\n`);
