#!/usr/bin/env node

import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJsonAtomic } from './atomic-file.mjs';
import { readRefinements, refinementRecords } from './image-review.mjs';
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

const [targetsArg, outputArg, workArg] = process.argv.slice(2);
if (!targetsArg || !outputArg || !workArg) {
  throw new Error('Usage: refine-rejected-image-prompts.mjs <rejected-targets.json> <output.json> <work-directory>');
}

const MODEL_CONFIG = resolveStructuredModel();
const { timeoutMs: MODEL_TIMEOUT_MS, retryDelayMs, concurrency } = stageSettings({ defaultTimeoutMinutes: 20 });
const lifecycle = createStageLifecycle();
const payload = JSON.parse(readFileSync(resolve(targetsArg), 'utf8'));
if (!Array.isArray(payload.targets)) throw new Error('Rejected target manifest is invalid');
const workDir = resolve(workArg);
mkdirSync(workDir, { recursive: true });
if (payload.targets.length === 0) {
  writeJsonAtomic(resolve(outputArg), payload);
  process.stderr.write('No rejected image prompts remain to refine\n');
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
        required: ['itemIndex', 'prompt', 'change'],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          prompt: { type: 'string', minLength: 40, maxLength: 1_200 },
          change: { type: 'string', maxLength: 400 },
        },
      },
    },
  },
};

const instruction = `You are a visual prompt editor for a modern American English learning app. Rewrite each rejected brief for one realistic, photorealistic 16:9 image.

The revised scene must teach the exact learning target at a glance and directly fix the judge's semantic concern. Reduce it to one iconic, observable moment instead of accumulating details from earlier briefs. Use one focal subject or relationship and at most two prominent people; a third is allowed only when the meaning inherently requires a three-party relationship. Background people must remain incidental. Never require multiple people to perform separate simultaneous gestures, or one person to perform both a visible and a concealed action. Make one diagnostic action, relationship, contrast, cause, or consequence large and unmistakable in a close or medium foreground composition. Do not try to render thoughts, rumors, identity, or intent directly; show one visible discovery, choice, or consequence from which the learner can infer it. Preserve only the context needed to distinguish this sense. For an abstract or figurative sense, show one everyday situation that demonstrates it; never use decorative symbolism or a misleading literal origin. Do not depend on readable documents, labels, signs, captions, typography, thought bubbles, arrows, split screens, collages, or before/after panels. Require authentic anatomy, objects, materials, and natural lighting. Explicitly prohibit illustration, animation, 3D rendering, visible text, logos, and watermarks. Keep each prompt under 70 words.

Return every itemIndex exactly once. The change field should briefly state how the revised composition fixes the rejected image. Return only schema-valid JSON.`;

const batches = [];
for (let index = 0; index < payload.targets.length; index += 20) {
  batches.push(payload.targets.slice(index, index + 20));
}

const filesFor = (batch, batchIndex) => batchFiles(workDir, batchIndex, batchFingerprint(MODEL_CONFIG, {
  instruction, schema, records: refinementRecords(batch),
}));

// Pairs each target with its refinement, so split batches can be put back in order.
async function refineBatch(batch, batchIndex) {
  const records = refinementRecords(batch);
  const refinements = await runCachedModelBatch({
    resultPath: filesFor(batch, batchIndex).result,
    prompt: correction => `${instruction}${correction}\n\nREFINE THESE REJECTED TARGETS:\n${JSON.stringify(records)}`,
    correction: message => `\n\nYour previous response failed validation: ${message}. Return every itemIndex exactly once.`,
    ask: ({ prompt, resultPath }) => runStructuredModel(MODEL_CONFIG, {
      prompt, schema, resultPath, timeoutMs: MODEL_TIMEOUT_MS, activeChildren: lifecycle.activeChildren,
    }),
    validate: parsed => readRefinements(parsed, batch, batchIndex + 1),
    retryDelayMs,
    lifecycle,
  });
  return refinements.map((refined, index) => ({ target: batch[index], refined }));
}

// A batch that keeps failing is halved down to the brief that fails alone. That brief is kept as it was; the
// next candidate still gets a new seed, and a target that never passes is deferred in the end.
function refineResilient(batch, batchIndex) {
  return runSplittingBatches(batch, {
    run: part => refineBatch(part, batchIndex),
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
        ? `Prompt-refinement batch ${batchIndex + 1} was split on an earlier run; resuming its ${left.length}+${right.length} halves\n`
        : `Prompt-refinement batch ${batchIndex + 1} failed (${error}); splitting ${part.length} briefs into ${left.length}+${right.length}\n`);
    },
    onSingletonFailure: async (target, message, error) => {
      await rethrowIfModelDown(error, MODEL_CONFIG, lifecycle);
      process.stderr.write(`The brief for ${target.imageId} could not be rewritten; keeping it: ${message}\n`);
      return {
        target,
        refined: {
          ...target,
          originalPrompt: target.originalPrompt || target.prompt,
          promptRefinement: 'unchanged: the prompt editor could not rewrite this brief',
        },
      };
    },
    lifecycle,
  });
}

const refinedByTarget = new Map();
await runPool(batches.length, concurrency, lifecycle, async index => {
  process.stderr.write(`Refining rejected prompt batch ${index + 1}/${batches.length}\n`);
  const { results, failures } = await refineResilient(batches[index], index);
  for (const { target, refined } of [...results, ...failures]) refinedByTarget.set(target, refined);
});

writeJsonAtomic(resolve(outputArg), { ...payload, targets: payload.targets.map(target => refinedByTarget.get(target)) });
process.stderr.write(`Refined ${payload.targets.length} rejected image prompt(s)\n`);
