#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { candidateFile, judgmentRecords, readVerdicts } from './image-review.mjs';
import {
  batchFiles,
  batchFingerprint,
  createStageLifecycle,
  runCachedModelBatch,
  runPool,
  stageSettings,
} from './model-stage.mjs';
import { resolveStructuredModel, runStructuredModel } from './structured-model.mjs';

const [targetsArg, candidatesArg, imagesArg, workArg, candidateNumberArg] = process.argv.slice(2);
if (!targetsArg || !candidatesArg || !imagesArg || !workArg) {
  throw new Error('Usage: judge-image-candidates.mjs <targets.json> <candidate-directory> <image-directory> <work-directory> [candidate-number=1]');
}
const candidateNumber = Number(candidateNumberArg || 1);
if (!Number.isSafeInteger(candidateNumber) || candidateNumber < 1 || candidateNumber > 99) {
  throw new Error('Candidate number must be an integer from 1 to 99');
}

const MODEL_CONFIG = resolveStructuredModel();
const { timeoutMs: MODEL_TIMEOUT_MS, retryDelayMs, concurrency } = stageSettings({
  defaultTimeoutMinutes: 20,
  maxConcurrency: 8,
  concurrencyVariables: ['CODEX_IMAGE_CONCURRENCY', 'CODEX_CONCURRENCY'],
});
const lifecycle = createStageLifecycle();
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

// The prompt is JUDGMENT_INTRODUCTION, the batch's records, then JUDGMENT_POLICY.
const JUDGMENT_INTRODUCTION = 'Act as a rigorous but practical visual editor for an American English learning app. Each attached image corresponds, in attachment order, to the itemIndex record below:';
const JUDGMENT_POLICY = 'Judge each image independently against learningTarget.text, learningTarget.sense, and learningTarget.definition. The brief describes one possible composition; it is guidance, not a shot-list contract. For a concrete, directly photographable target, accept when a learner can infer the core contextual meaning at a glance, the image does not contradict that meaning, and the scene is realistic and visually coherent. For an abstract, rhetorical, figurative, relational, or logical target that cannot be uniquely photographed, accept a coherent, memorable concrete scenario or visual metaphor that reinforces the intended meaning when shown beside the sentence; do not require the image alone to name the formal concept or encode every logical step without its accompanying sentence. Semantic usefulness outweighs literal compliance with incidental staging. Do not reject solely because of an omitted secondary action, exact person count, camera angle, accessory, facial micro-expression, or precise body position when the central teaching meaning remains clear. Reject semantic mismatches, genuinely ambiguous generic stock imagery, misleading literal depictions of figurative language, materially broken anatomy or objects, empty decorative symbolism, animation, illustration, or distracting visible text/logos. A minor cosmetic flaw is not enough to reject an otherwise accurate teaching image. Copy every itemIndex exactly and return only schema-valid JSON.';

const pending = payload.targets.filter(target => !existsSync(join(imageDir, target.filename)));
const batches = [];
for (let index = 0; index < pending.length; index += 8) batches.push(pending.slice(index, index + 8));

function judgeBatch(batch, batchIndex) {
  const records = judgmentRecords(batch, candidateNumber);
  const fingerprint = batchFingerprint(MODEL_CONFIG, {
    instruction: [JUDGMENT_INTRODUCTION, JUDGMENT_POLICY], schema, records,
  });
  const candidates = batch.map(target => candidateFile(candidateDir, target.filename, candidateNumber));
  if (candidates.some(path => !existsSync(path))) throw new Error(`Batch ${batchIndex + 1} is missing a candidate image`);
  return runCachedModelBatch({
    resultPath: batchFiles(workDir, batchIndex, fingerprint).result,
    prompt: correction => `${JUDGMENT_INTRODUCTION}\n${JSON.stringify(records)}\n\n${JUDGMENT_POLICY}${correction}`,
    correction: message => ` Your previous response failed validation: ${message}. Return every itemIndex exactly once.`,
    ask: ({ prompt, resultPath }) => runStructuredModel(MODEL_CONFIG, {
      prompt, schema, resultPath, images: candidates, timeoutMs: MODEL_TIMEOUT_MS, activeChildren: lifecycle.activeChildren,
    }),
    validate: parsed => readVerdicts(parsed, batch, candidates, batchIndex + 1),
    retryDelayMs,
    lifecycle,
  });
}

const results = new Array(batches.length);
await runPool(batches.length, concurrency, lifecycle, async index => {
  process.stderr.write(`Judging image batch ${index + 1}/${batches.length}\n`);
  results[index] = await judgeBatch(batches[index], index);
});

const rejected = [];
for (const batch of results) {
  for (const { target, result, candidate } of batch) {
    if (result.acceptable) copyFileSync(candidate, join(imageDir, target.filename));
    else rejected.push({ ...target, rejectionReason: result.reason });
  }
}
writeFileSync(join(workDir, 'rejected-targets.json'), `${JSON.stringify({ ...payload, targets: rejected }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Accepted ${pending.length - rejected.length}/${pending.length}; rejected ${rejected.length}\n`);
