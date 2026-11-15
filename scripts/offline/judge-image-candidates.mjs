#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { copyFileAtomic, fileReady, writeJsonAtomic } from './atomic-file.mjs';
import { candidateFile, judgmentRecords, readVerdicts } from './image-review.mjs';
import {
  batchFiles,
  batchFingerprint,
  createStageLifecycle,
  rethrowIfModelDown,
  runCachedModelBatch,
  runPool,
  runSplittingBatches,
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
  writeJsonAtomic(join(workDir, 'rejected-targets.json'), payload);
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

// Like every other stage, an empty file is no accepted image.
const pending = payload.targets.filter(target => !fileReady(join(imageDir, target.filename)));
const batches = [];
for (let index = 0; index < pending.length; index += 8) batches.push(pending.slice(index, index + 8));

const candidatePath = target => candidateFile(candidateDir, target.filename, candidateNumber);
const filesFor = (batch, batchIndex) => batchFiles(workDir, batchIndex, batchFingerprint(MODEL_CONFIG, {
  instruction: [JUDGMENT_INTRODUCTION, JUDGMENT_POLICY], schema, records: judgmentRecords(batch, candidateNumber),
}));

// Each accepted candidate is copied into place as soon as its batch is judged, so a later failure keeps it.
async function judgeBatch(batch, batchIndex) {
  const records = judgmentRecords(batch, candidateNumber);
  const candidates = batch.map(candidatePath);
  const verdicts = await runCachedModelBatch({
    resultPath: filesFor(batch, batchIndex).result,
    prompt: correction => `${JUDGMENT_INTRODUCTION}\n${JSON.stringify(records)}\n\n${JUDGMENT_POLICY}${correction}`,
    correction: message => ` Your previous response failed validation: ${message}. Return every itemIndex exactly once.`,
    ask: ({ prompt, resultPath }) => runStructuredModel(MODEL_CONFIG, {
      prompt, schema, resultPath, images: candidates, timeoutMs: MODEL_TIMEOUT_MS, activeChildren: lifecycle.activeChildren,
    }),
    validate: parsed => readVerdicts(parsed, batch, candidates, batchIndex + 1),
    retryDelayMs,
    lifecycle,
  });
  for (const { target, result, candidate } of verdicts) {
    if (result.acceptable) copyFileAtomic(candidate, join(imageDir, target.filename));
  }
  return verdicts;
}

// A batch that keeps failing is halved down to the image that fails alone. That image is rejected as one the
// reviewer could not judge, so the loop renders it a new candidate and in the end defers it, instead of
// failing its chunk and every later one on every cycle.
function judgeResilient(batch, batchIndex) {
  return runSplittingBatches(batch, {
    run: part => judgeBatch(part, batchIndex),
    markerPath: part => filesFor(part, batchIndex).splitMarker,
    marker: (part, error, depth) => ({
      version: 1,
      batchIndex,
      depth,
      imageIds: part.map(target => target.imageId),
      error,
      splitAt: new Date().toISOString(),
    }),
    onSplit: ({ batch: part, halves: [left, right], error, resumed }) => {
      process.stderr.write(resumed
        ? `Image judgment batch ${batchIndex + 1} was split on an earlier run; resuming its ${left.length}+${right.length} halves\n`
        : `Image judgment batch ${batchIndex + 1} failed (${error}); splitting ${part.length} images into ${left.length}+${right.length}\n`);
    },
    onSingletonFailure: async (target, message, error) => {
      await rethrowIfModelDown(error, MODEL_CONFIG, lifecycle);
      process.stderr.write(`Image ${target.imageId} could not be judged; rejecting this candidate: ${message}\n`);
      return { target, reason: `The reviewer could not judge this image: ${message.slice(0, 200)}` };
    },
    lifecycle,
  });
}

const rejectionReasons = new Map();
await runPool(batches.length, concurrency, lifecycle, async index => {
  const batch = batches[index];
  process.stderr.write(`Judging image batch ${index + 1}/${batches.length}\n`);
  // A missing candidate means the renderer and this stage disagree, which is no fault of the image.
  if (batch.some(target => !existsSync(candidatePath(target)))) throw new Error(`Batch ${index + 1} is missing a candidate image`);
  const { results: verdicts, failures: unjudged } = await judgeResilient(batch, index);
  for (const { target, result } of verdicts) if (!result.acceptable) rejectionReasons.set(target, result.reason);
  for (const { target, reason } of unjudged) rejectionReasons.set(target, reason);
});

const rejected = pending.filter(target => rejectionReasons.has(target))
  .map(target => ({ ...target, rejectionReason: rejectionReasons.get(target) }));
writeJsonAtomic(join(workDir, 'rejected-targets.json'), { ...payload, targets: rejected });
process.stderr.write(`Accepted ${pending.length - rejected.length}/${pending.length}; rejected ${rejected.length}\n`);
