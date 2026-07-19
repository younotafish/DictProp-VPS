#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { killCodex, spawnCodex } from './codex-process.mjs';

const [targetsArg, outputArg, workArg] = process.argv.slice(2);
if (!targetsArg || !outputArg || !workArg) {
  throw new Error('Usage: refine-rejected-image-prompts.mjs <rejected-targets.json> <output.json> <work-directory>');
}

const MODEL = 'gpt-5.6-sol';
const activeChildren = new Set();
let aborting = false;
const payload = JSON.parse(readFileSync(resolve(targetsArg), 'utf8'));
if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
  throw new Error('Rejected target manifest is invalid or empty');
}
const workDir = resolve(workArg);
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
const schemaPath = join(workDir, 'refinement-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

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
    }, 12 * 60 * 1000);
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

const instruction = `You are a visual prompt editor for a modern American English learning app. Rewrite each rejected brief for one realistic, photorealistic 16:9 image.

The revised scene must teach the exact learning target at a glance and directly fix the judge's rejection. Simplify the cast and setting. Make the single diagnostic action, relationship, contrast, cause, or consequence large and unmistakable in the foreground. Preserve context that distinguishes this exact sense from related meanings. For an abstract or figurative sense, show one plausible everyday situation that demonstrates its intended meaning; never use decorative symbolism or a misleading literal origin. Do not rely on readable documents, labels, signs, captions, typography, thought bubbles, arrows, split screens, collages, or before/after panels to explain the concept. Require authentic anatomy, objects, materials, and natural lighting. Explicitly prohibit illustration, animation, 3D rendering, visible text, logos, and watermarks. Keep each prompt under 110 words.

Return every itemIndex exactly once. The change field should briefly state how the revised composition fixes the rejected image. Return only schema-valid JSON.`;

const batches = [];
for (let index = 0; index < payload.targets.length; index += 20) {
  batches.push(payload.targets.slice(index, index + 20));
}

async function refineBatch(batch, batchIndex) {
  const records = batch.map((target, itemIndex) => ({
    itemIndex,
    learningTarget: target.learningTarget,
    rejectedBrief: target.prompt,
    rejectionReason: target.rejectionReason || 'The previous image did not communicate the exact meaning clearly enough.',
  }));
  const fingerprint = createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        await runCodex([
          'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
          '-m', MODEL, '--output-schema', schemaPath, '-o', resultPath, '-',
        ], `${instruction}${correction}\n\nREFINE THESE REJECTED TARGETS:\n${JSON.stringify(records)}`);
      }
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
        throw new Error(`Batch ${batchIndex + 1} returned the wrong result count`);
      }
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error(`Batch ${batchIndex + 1} returned duplicate indexes`);
      return batch.map((target, itemIndex) => {
        const result = byIndex.get(itemIndex);
        if (!result || typeof result.prompt !== 'string' || result.prompt.trim().length < 40) {
          throw new Error(`Batch ${batchIndex + 1} omitted index ${itemIndex}`);
        }
        return {
          ...target,
          originalPrompt: target.originalPrompt || target.prompt,
          prompt: result.prompt.trim(),
          promptRefinement: result.change.trim(),
        };
      });
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nYour previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Return every itemIndex exactly once.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`Prompt-refinement batch ${batchIndex + 1} exhausted retries`);
}

const results = new Array(batches.length);
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(64, Number(process.env.CODEX_CONCURRENCY || 20)));
async function worker() {
  for (;;) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    process.stderr.write(`Refining rejected prompt batch ${index + 1}/${batches.length}\n`);
    results[index] = await refineBatch(batches[index], index);
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

writeFileSync(resolve(outputArg), `${JSON.stringify({
  ...payload,
  targets: results.flat(),
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Refined ${payload.targets.length} rejected image prompt(s)\n`);
