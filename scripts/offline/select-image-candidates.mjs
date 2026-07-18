#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [targetsArg, candidatesArg, imagesArg, workArg] = process.argv.slice(2);
if (!targetsArg || !candidatesArg || !imagesArg) {
  throw new Error('Usage: select-image-candidates.mjs <targets.json> <candidate-directory> <image-directory> [work-directory]');
}

const MODEL = 'gpt-5.6-sol';
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

for (let index = 0; index < payload.targets.length; index++) {
  const target = payload.targets[index];
  const finalPath = join(imageDir, target.filename);
  if (existsSync(finalPath)) continue;
  const stem = target.filename.replace(/\.[^.]+$/, '');
  const candidates = [1, 2, 3].map(number => join(candidateDir, `${stem}-${number}.jpg`));
  if (candidates.some(path => !existsSync(path))) throw new Error(`Missing candidates for ${target.imageId}`);
  const decisionPath = join(workDir, `${stem}.json`);
  if (!existsSync(decisionPath)) {
    const prompt = `Act as a strict visual editor for an American English learning app. The three attached images were generated for this learning target:\n${JSON.stringify(target.learningTarget)}\n\nGeneration brief:\n${target.prompt}\n\nChoose the image that most directly and unambiguously communicates the EXACT contextual meaning. Semantic correctness outweighs beauty. Then judge realism, coherent anatomy/objects, plausible action and relationships, lack of unintended text/logos, and useful 16:9 composition. Reject generic stock imagery, literal depictions of an idiom when the sentence uses its figurative meaning, decorative symbolism, animation, illustration, or scenes that omit a defining detail. Set acceptable=false only if all three would actively misteach the meaning. Candidate numbers correspond to attachment order. Return only schema-valid JSON.`;
    const args = [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
      '-m', MODEL, '-c', 'model_reasoning_effort="high"',
      ...candidates.flatMap(path => ['-i', path]),
      '--output-schema', schemaPath, '-o', decisionPath, '-',
    ];
    execFileSync('/usr/local/bin/codex', args, { input: prompt, stdio: ['pipe', 'inherit', 'inherit'], timeout: 30 * 60 * 1000 });
  }
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  if (![1, 2, 3].includes(decision.winner) || typeof decision.acceptable !== 'boolean') {
    throw new Error(`Invalid image decision for ${target.imageId}`);
  }
  if (!decision.acceptable) process.stderr.write(`WARNING: all candidates need review for ${target.imageId}: ${decision.reason}\n`);
  copyFileSync(candidates[decision.winner - 1], finalPath);
  process.stderr.write(`Selected ${index + 1}/${payload.targets.length}: ${target.imageId} candidate ${decision.winner}\n`);
}
