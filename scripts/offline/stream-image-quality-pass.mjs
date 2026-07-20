#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [targetsArg, candidatesArg, imagesArg, workArg, outputArg, candidateArg, chunkSizeArg] = process.argv.slice(2);
if (!targetsArg || !candidatesArg || !imagesArg || !workArg || !outputArg) {
  throw new Error('Usage: stream-image-quality-pass.mjs <targets.json> <candidates-dir> <images-dir> <work-dir> <refined-output.json> [candidate=1] [chunk-size=128]');
}

const candidateNumber = Number(candidateArg || 1);
const chunkSize = Number(chunkSizeArg || 128);
if (!Number.isSafeInteger(candidateNumber) || candidateNumber < 1 || candidateNumber > 99) {
  throw new Error('Candidate number must be an integer from 1 to 99');
}
if (!Number.isSafeInteger(chunkSize) || chunkSize < 8 || chunkSize > 2_048) {
  throw new Error('Chunk size must be an integer from 8 to 2048');
}

const payload = JSON.parse(readFileSync(resolve(targetsArg), 'utf8'));
if (!Array.isArray(payload.targets)) throw new Error('Target manifest is invalid');
const candidateDir = resolve(candidatesArg);
const imageDir = resolve(imagesArg);
const workDir = resolve(workArg);
const outputPath = resolve(outputArg);
mkdirSync(workDir, { recursive: true });
mkdirSync(dirname(outputPath), { recursive: true });

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const detachedProcessGroups = process.platform !== 'win32';
let activeChild = null;
let handlingSignal = false;

function killActiveChild(signal) {
  if (!activeChild?.pid) return;
  try {
    if (detachedProcessGroups) process.kill(-activeChild.pid, signal);
    else activeChild.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    if (detachedProcessGroups && error?.code === 'EPERM') {
      try {
        activeChild.kill(signal);
      } catch (childError) {
        if (childError?.code !== 'ESRCH' && childError?.code !== 'EPERM') throw childError;
      }
      return;
    }
    throw error;
  }
}

function forwardSignal(signal) {
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  if (handlingSignal) {
    killActiveChild('SIGKILL');
    process.exit(exitCode);
  }
  handlingSignal = true;
  if (!activeChild?.pid) process.exit(exitCode);
  killActiveChild(signal);
  setTimeout(() => {
    killActiveChild('SIGKILL');
    process.exit(exitCode);
  }, 3_000);
}
process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

function candidatePath(target) {
  return join(candidateDir, target.filename.replace(/(\.[^.]+)$/, `-${candidateNumber}$1`));
}

function fileReady(path) {
  return existsSync(path) && statSync(path).size > 0;
}

function targetReady(target) {
  return fileReady(join(imageDir, target.filename)) || fileReady(candidatePath(target));
}

function readTargetManifest(path, label) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(manifest.targets)) throw new Error(`${label} is invalid`);
  return manifest;
}

function validateChunkPartition(targets, rejected, label) {
  const targetFiles = new Set(targets.map(target => target.filename));
  const rejectedFiles = new Set();
  for (const target of rejected) {
    if (!targetFiles.has(target.filename) || rejectedFiles.has(target.filename)) {
      throw new Error(`${label} contains an unknown or duplicate target: ${target.filename}`);
    }
    rejectedFiles.add(target.filename);
  }
  for (const target of targets) {
    const accepted = fileReady(join(imageDir, target.filename));
    const wasRejected = rejectedFiles.has(target.filename);
    if (accepted === wasRejected) {
      throw new Error(`${label} does not partition target ${target.imageId || target.filename}`);
    }
  }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
      detached: detachedProcessGroups,
    });
    activeChild = child;
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function retry(command, args) {
  let attempt = 0;
  for (;;) {
    try {
      await run(command, args);
      return;
    } catch (error) {
      attempt += 1;
      process.stderr.write(`[${new Date().toISOString()}] quality command failed (attempt ${attempt}); retrying in 60s: ${error instanceof Error ? error.message : String(error)}\n`);
      await sleep(60_000);
    }
  }
}

const refinedTargets = [];
const chunks = [];
for (let index = 0; index < payload.targets.length; index += chunkSize) {
  chunks.push(payload.targets.slice(index, index + chunkSize));
}

for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
  const targets = chunks[chunkIndex];
  const chunkName = `chunk-${String(chunkIndex + 1).padStart(4, '0')}`;
  const chunkDir = join(workDir, chunkName);
  const chunkManifest = join(chunkDir, 'targets.json');
  const judgeDir = join(chunkDir, 'judge');
  const rejectedPath = join(judgeDir, 'rejected-targets.json');
  const refinedPath = join(chunkDir, 'refined.json');
  const refineDir = join(chunkDir, 'refine');

  if (fileReady(refinedPath)) {
    const refined = readTargetManifest(refinedPath, `${chunkName} refinement checkpoint`);
    validateChunkPartition(targets, refined.targets, `${chunkName} refinement checkpoint`);
    refinedTargets.push(...refined.targets);
    process.stderr.write(`Reusing completed candidate ${candidateNumber} ${chunkName}\n`);
    continue;
  }

  let lastMissing = -1;
  for (;;) {
    const missing = targets.reduce((count, target) => count + (targetReady(target) ? 0 : 1), 0);
    if (missing === 0) break;
    if (missing !== lastMissing) {
      process.stderr.write(`Candidate ${candidateNumber}, chunk ${chunkIndex + 1}/${chunks.length}: waiting for ${missing}/${targets.length} image(s)\n`);
      lastMissing = missing;
    }
    await sleep(15_000);
  }

  mkdirSync(chunkDir, { recursive: true });
  writeFileSync(chunkManifest, `${JSON.stringify({ ...payload, targets }, null, 2)}\n`, { mode: 0o600 });

  if (fileReady(rejectedPath)) {
    const rejected = readTargetManifest(rejectedPath, `${chunkName} judgment checkpoint`);
    validateChunkPartition(targets, rejected.targets, `${chunkName} judgment checkpoint`);
    process.stderr.write(`Reusing completed candidate ${candidateNumber} judgment for ${chunkName}\n`);
  } else {
    process.stderr.write(`Judging candidate ${candidateNumber}, chunk ${chunkIndex + 1}/${chunks.length}\n`);
    await retry(process.execPath, [
      'scripts/offline/judge-image-candidates.mjs', chunkManifest, candidateDir, imageDir, judgeDir,
      String(candidateNumber),
    ]);
    const rejected = readTargetManifest(rejectedPath, `${chunkName} judgment checkpoint`);
    validateChunkPartition(targets, rejected.targets, `${chunkName} judgment checkpoint`);
  }
  await retry(process.execPath, [
    'scripts/offline/refine-rejected-image-prompts.mjs', rejectedPath, refinedPath, refineDir,
  ]);
  const refined = readTargetManifest(refinedPath, `${chunkName} refinement checkpoint`);
  validateChunkPartition(targets, refined.targets, `${chunkName} refinement checkpoint`);
  refinedTargets.push(...refined.targets);
}

writeFileSync(outputPath, `${JSON.stringify({
  ...payload,
  qualityPassGeneratedAt: new Date().toISOString(),
  candidateNumber,
  targets: refinedTargets,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Candidate ${candidateNumber} quality pass complete: accepted=${payload.targets.length - refinedTargets.length}, rejected=${refinedTargets.length}\n`);
