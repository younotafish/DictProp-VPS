#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { killCodex, spawnCodex } from './codex-process.mjs';

const [targetsArg, candidatesArg, imagesArg, workArg] = process.argv.slice(2);
if (!targetsArg || !candidatesArg || !imagesArg) {
  throw new Error('Usage: select-image-candidates.mjs <targets.json> <candidate-directory> <image-directory> [work-directory]');
}

const MODEL = 'gpt-5.6-sol';
const activeChildren = new Set();
let aborting = false;
const payload = JSON.parse(readFileSync(resolve(targetsArg), 'utf8'));
if (!Array.isArray(payload.targets) || payload.targets.length === 0) throw new Error('Target manifest is invalid or empty');
const candidateDir = resolve(candidatesArg);
const imageDir = resolve(imagesArg);
const workDir = resolve(workArg || join(imageDir, '..', 'selection-work'));
mkdirSync(imageDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'acceptable', 'reason'],
  properties: {
    winner: { type: 'integer', minimum: 1, maximum: 3 },
    acceptable: { type: 'boolean' },
    reason: { type: 'string' },
  },
};
const schemaPath = join(workDir, 'selection-schema.json');
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
    }, 15 * 60 * 1000);
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

async function selectTarget(target, index) {
  const finalPath = join(imageDir, target.filename);
  if (existsSync(finalPath)) return { accepted: true, skipped: true };
  const extension = target.filename.match(/\.[^.]+$/)?.[0];
  if (!extension) throw new Error(`Missing image extension for ${target.imageId}`);
  const stem = target.filename.slice(0, -extension.length);
  const candidates = [1, 2, 3].map(number => join(candidateDir, `${stem}-${number}${extension}`));
  if (candidates.some(path => !existsSync(path))) throw new Error(`Missing candidates for ${target.imageId}`);
  const decisionPath = join(workDir, `${stem}.json`);
  let decision;
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(decisionPath)) {
        const prompt = `Act as a strict visual editor for an American English learning app. The three attached images were generated for this learning target:\n${JSON.stringify(target.learningTarget)}\n\nGeneration brief:\n${target.prompt}\n\nChoose the image that most directly and unambiguously communicates the EXACT contextual meaning. Semantic correctness outweighs beauty. Then judge realism, coherent anatomy/objects, plausible action and relationships, lack of unintended text/logos, and useful 16:9 composition. Reject generic stock imagery, literal depictions of an idiom when the sentence uses its figurative meaning, decorative symbolism, animation, illustration, or scenes that omit a defining detail. Set acceptable=false only if all three would actively misteach the meaning. Candidate numbers correspond to attachment order. Return only schema-valid JSON.${correction}`;
        const args = [
          'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
          '-m', MODEL,
          ...candidates.flatMap(path => ['-i', path]),
          '--output-schema', schemaPath, '-o', decisionPath, '-',
        ];
        await runCodex(args, prompt);
      }
      decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
      if (![1, 2, 3].includes(decision.winner) || typeof decision.acceptable !== 'boolean') {
        throw new Error(`Invalid image decision for ${target.imageId}`);
      }
      break;
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = ` Your previous response failed validation: ${error instanceof Error ? error.message : String(error)}.`;
      if (existsSync(decisionPath)) unlinkSync(decisionPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  if (!decision.acceptable) {
    process.stderr.write(`REJECTED ${target.imageId}: ${decision.reason}\n`);
    return { accepted: false, target, reason: decision.reason };
  }
  copyFileSync(candidates[decision.winner - 1], finalPath);
  process.stderr.write(`Selected ${index + 1}/${payload.targets.length}: ${target.imageId} candidate ${decision.winner}\n`);
  return { accepted: true };
}

const results = new Array(payload.targets.length);
let nextTarget = 0;
const concurrency = Math.max(1, Math.min(64, Number(process.env.CODEX_CONCURRENCY || 20)));
async function worker() {
  for (;;) {
    const index = nextTarget++;
    if (index >= payload.targets.length) return;
    results[index] = await selectTarget(payload.targets[index], index);
  }
}
async function terminateActiveChildren() {
  aborting = true;
  for (const child of activeChildren) killCodex(child, 'SIGTERM');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  for (const child of activeChildren) killCodex(child, 'SIGKILL');
}
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, payload.targets.length) }, () => worker()));
} catch (error) {
  await terminateActiveChildren();
  throw error;
}
const rejected = results.filter(result => result && !result.accepted);
writeFileSync(join(workDir, 'rejected-targets.json'), `${JSON.stringify({
  ...payload,
  targets: rejected.map(result => ({ ...result.target, rejectionReason: result.reason })),
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Selected an acceptable image for ${results.length - rejected.length}/${results.length} target(s); ${rejected.length} need another generation round\n`);
