#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installCodexSignalCleanup, killCodex } from './codex-process.mjs';
import {
  createLocalMlxClient,
  DEFAULT_LOCAL_MLX_VLM_MODEL,
  DEFAULT_LOCAL_MLX_VLM_PYTHON,
  extractJsonObject,
} from './local-mlx-client.mjs';

const [targetsArg, candidatesArg, imagesArg, workArg, candidateNumberArg] = process.argv.slice(2);
if (!targetsArg || !candidatesArg || !imagesArg || !workArg) {
  throw new Error('Usage: judge-image-candidates.mjs <targets.json> <candidate-directory> <image-directory> <work-directory> [candidate-number=1]');
}
const candidateNumber = Number(candidateNumberArg || 1);
if (!Number.isSafeInteger(candidateNumber) || candidateNumber < 1 || candidateNumber > 99) {
  throw new Error('Candidate number must be an integer from 1 to 99');
}

const MODEL = process.env.LOCAL_MLX_VLM_MODEL_ID || 'mlx-community/Qwen3-VL-8B-Instruct-4bit';
const JUDGMENT_POLICY_VERSION = 2;
const activeChildren = new Set();
let aborting = false;
let localClient;
installCodexSignalCleanup(activeChildren, () => { aborting = true; });
const payload = JSON.parse(readFileSync(resolve(targetsArg), 'utf8'));
if (!Array.isArray(payload.targets)) throw new Error('Target manifest is invalid');
const candidateDir = resolve(candidatesArg);
const imageDir = resolve(imagesArg);
const workDir = resolve(workArg);
mkdirSync(imageDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
if (payload.targets.length === 0) {
  writeFileSync(join(workDir, 'rejected-targets.json'), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write('No image candidates remain to judge\n');
  process.exit(0);
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

function getLocalClient() {
  localClient ??= createLocalMlxClient({
    python: process.env.LOCAL_MLX_VLM_PYTHON || DEFAULT_LOCAL_MLX_VLM_PYTHON,
    model: process.env.LOCAL_MLX_VLM_MODEL || DEFAULT_LOCAL_MLX_VLM_MODEL,
    worker: process.env.LOCAL_MLX_VLM_WORKER || resolve('scripts/offline/local-mlx-vlm-worker.py'),
    timeoutMs: 20 * 60 * 1_000,
    activeChildren,
  });
  return localClient;
}

async function judgeBatch(batch, batchIndex) {
  const records = batch.map((target, itemIndex) => ({
    itemIndex,
    candidateNumber,
    learningTarget: target.learningTarget,
    brief: target.prompt,
  }));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ judgmentPolicyVersion: JUDGMENT_POLICY_VERSION, model: MODEL, records }))
    .digest('hex')
    .slice(0, 16);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
  const candidates = batch.map(target => join(
    candidateDir,
    target.filename.replace(/(\.[^.]+)$/, `-${candidateNumber}$1`),
  ));
  if (candidates.some(path => !existsSync(path))) throw new Error(`Batch ${batchIndex + 1} is missing a candidate image`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        const prompt = `Act as a rigorous but practical visual editor for an American English learning app. Each attached image corresponds, in attachment order, to the itemIndex record below:\n${JSON.stringify(records)}\n\nJudge each image independently against learningTarget.text, learningTarget.sense, and learningTarget.definition. The brief describes one possible composition; it is guidance, not a shot-list contract. Accept when a learner can infer the core contextual meaning at a glance, the image does not contradict that meaning, and the scene is realistic and visually coherent. Semantic usefulness outweighs literal compliance with incidental staging. Do not reject solely because of an omitted secondary action, exact person count, camera angle, accessory, facial micro-expression, or precise body position when the central teaching meaning remains clear. Reject semantic mismatches, genuinely ambiguous generic stock imagery, misleading literal depictions of figurative language, materially broken anatomy or objects, decorative symbolism, animation, illustration, or distracting visible text/logos. A minor cosmetic flaw is not enough to reject an otherwise accurate teaching image. Copy every itemIndex exactly and return only JSON matching this schema:\n${JSON.stringify(schema)}${correction}`;
        const response = await getLocalClient().generate(prompt, {
          images: candidates,
          maxTokens: 1_500,
          temperature: attempt === 0 ? 0 : 0.1,
        });
        writeFileSync(resultPath, `${JSON.stringify(extractJsonObject(response))}\n`, { mode: 0o600 });
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
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = ` Your previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Return every itemIndex exactly once.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`Image judgment batch ${batchIndex + 1} exhausted retries`);
}

const results = new Array(batches.length);
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(2, Number(process.env.LOCAL_MLX_VLM_CONCURRENCY || 1)));
async function worker() {
  for (;;) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    process.stderr.write(`Judging image batch ${index + 1}/${batches.length}\n`);
    results[index] = await judgeBatch(batches[index], index);
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

const rejected = [];
for (const batch of results) {
  for (const { target, result, candidate } of batch) {
    if (result.acceptable) copyFileSync(candidate, join(imageDir, target.filename));
    else rejected.push({ ...target, rejectionReason: result.reason });
  }
}
writeFileSync(join(workDir, 'rejected-targets.json'), `${JSON.stringify({ ...payload, targets: rejected }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Accepted ${pending.length - rejected.length}/${pending.length}; rejected ${rejected.length}\n`);
