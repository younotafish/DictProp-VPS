import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('streaming image QA reuses a completed chunk without judging it again', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-image-resume-'));
  const candidates = join(root, 'candidates');
  const images = join(root, 'images');
  const work = join(root, 'work');
  const chunk = join(work, 'chunk-0001');
  mkdirSync(candidates, { recursive: true });
  mkdirSync(images, { recursive: true });
  mkdirSync(chunk, { recursive: true });
  const targets = Array.from({ length: 8 }, (_, index) => ({
    imageId: `image-${index}`,
    filename: `image-${index}.webp`,
    prompt: `Prompt ${index}`,
  }));
  for (const target of targets.slice(0, 4)) writeFileSync(join(images, target.filename), 'accepted');
  const rejected = targets.slice(4);
  const targetsPath = join(root, 'targets.json');
  const outputPath = join(root, 'refined.json');
  writeJson(targetsPath, { version: 1, targets });
  writeJson(join(chunk, 'refined.json'), { version: 1, targets: rejected });

  execFileSync(process.execPath, [
    resolve('..', 'scripts', 'offline', 'stream-image-quality-pass.mjs'),
    targetsPath,
    candidates,
    images,
    work,
    outputPath,
    '2',
    '8',
  ]);
  const output = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.deepEqual(output.targets.map((target: { imageId: string }) => target.imageId),
    rejected.map(target => target.imageId));
  assert.equal(readFileSync(join(images, 'image-0.webp'), 'utf8'), 'accepted');
});

test('streaming image QA reuses historical rejections accepted by a later candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-image-later-accepted-'));
  const candidates = join(root, 'candidates');
  const images = join(root, 'images');
  const work = join(root, 'work');
  const chunk = join(work, 'chunk-0001');
  mkdirSync(candidates, { recursive: true });
  mkdirSync(images, { recursive: true });
  mkdirSync(chunk, { recursive: true });
  const targets = Array.from({ length: 8 }, (_, index) => ({
    imageId: `image-${index}`,
    filename: `image-${index}.webp`,
    prompt: `Prompt ${index}`,
  }));
  for (const target of targets.slice(0, 6)) writeFileSync(join(images, target.filename), 'accepted');
  const historicallyRejected = targets.slice(4);
  const targetsPath = join(root, 'targets.json');
  const outputPath = join(root, 'refined.json');
  writeJson(targetsPath, { version: 1, targets });
  writeJson(join(chunk, 'refined.json'), { version: 1, targets: historicallyRejected });

  execFileSync(process.execPath, [
    resolve('..', 'scripts', 'offline', 'stream-image-quality-pass.mjs'),
    targetsPath,
    candidates,
    images,
    work,
    outputPath,
    '1',
    '8',
  ]);
  const output = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.deepEqual(output.targets.map((target: { imageId: string }) => target.imageId),
    historicallyRejected.map(target => target.imageId));
});

// Answers judge and prompt-refinement requests like `claude -p`: briefs mentioning "unrenderable" always fail.
const fakeClaude = `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const prompt = process.argv.includes('stream-json')
    ? JSON.parse(input).message.content.filter(block => block.type === 'text').map(block => block.text).join('\\n')
    : input;
  const records = JSON.parse(prompt.split('\\n').find(line => line.startsWith('[{"itemIndex"')));
  const schema = JSON.parse(process.argv[process.argv.indexOf('--json-schema') + 1]);
  const judging = schema.properties.results.items.required.includes('acceptable');
  const results = records.map(record => judging
    ? { itemIndex: record.itemIndex, acceptable: !record.brief.includes('unrenderable'), reason: 'Fake judgment.' }
    : { itemIndex: record.itemIndex, prompt: record.rejectedBrief + ' Refined.', change: 'Fake refinement.' });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { results } }) + '\\n');
});
`;

test('streaming image QA defers images that exhaust their candidates and keeps accepted ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-image-defer-'));
  const candidates = join(root, 'candidates');
  const images = join(root, 'images');
  mkdirSync(candidates, { recursive: true });
  mkdirSync(images, { recursive: true });
  const renderer = join(root, 'python');
  const claude = join(root, 'claude.cjs');
  // Every candidate already exists, so the renderer has nothing to do.
  writeFileSync(renderer, '#!/bin/sh\nexit 0\n');
  writeFileSync(claude, fakeClaude);
  chmodSync(renderer, 0o700);
  chmodSync(claude, 0o700);
  const targets = [
    { imageId: 'easy', filename: 'easy.webp', prompt: 'A photorealistic dugout with players shouting from the bench.' },
    { imageId: 'hard', filename: 'hard.webp', prompt: 'A photorealistic but unrenderable cloud chamber full of thin tracks.' },
  ].map(target => ({ ...target, learningTarget: { kind: 'word sense', text: target.imageId, sense: '', definition: '' } }));
  for (const target of targets) {
    for (const candidate of [1, 2]) writeFileSync(join(candidates, `${target.imageId}-${candidate}.webp`), 'candidate');
  }
  const targetsPath = join(root, 'targets.json');
  writeJson(targetsPath, { version: 1, targets });

  const output = execFileSync('bash', [
    resolve('..', 'scripts', 'offline', 'run-streaming-image-quality-loop.sh'),
    targetsPath, candidates, images, join(root, 'work'), '1024', '576', '4', '1', '8',
  ], {
    cwd: resolve('..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KREA_PYTHON: renderer,
      CLAUDE_BIN: claude,
      ENRICHMENT_MODEL_PROVIDER: 'claude',
      IMAGE_MODEL: 'ernie-image-turbo',
      IMAGE_QUALITY_DEFER_AFTER: '2',
    },
  });

  assert.match(output, /candidate 1: accepted=1, rejected=1/);
  assert.match(output, /deferring 1 image\(s\) that failed 2 candidates to a later cycle/);
  assert.equal(readFileSync(join(images, 'easy.webp'), 'utf8'), 'candidate');
  assert.equal(existsSync(join(images, 'hard.webp')), false);
  // A later cycle must render fresh candidates instead of re-judging the rejected ones.
  assert.deepEqual(readdirSync(candidates).sort(), ['easy-1.webp', 'easy-2.webp']);
});

test('example enrichment publication excludes published and production-covered images', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-image-publication-'));
  const imageRoot = join(root, 'image-bundle');
  const imageDirectory = join(imageRoot, 'images');
  const output = join(root, 'wave');
  mkdirSync(imageDirectory, { recursive: true });

  const sentences = ['a', 'b', 'c'].map(id => ({
    id: `sentence-${id}`,
    text: `Sentence ${id}`,
    lookupHash: `lookup-${id}`,
    textHash: `text-${id}`,
  }));
  (sentences[2] as any).hasImage = true;
  const source = join(root, 'source.json');
  const analysis = join(root, 'analysis.json');
  const analysisOnly = join(root, 'analysis-only.json');
  const publishedImage = join(root, 'published-image.json');
  writeJson(source, { version: 1, sentences });
  writeJson(analysis, {
    version: 1,
    entries: sentences.map(sentence => ({
      id: sentence.id,
      textHash: sentence.textHash,
      analysis: { translation: sentence.text },
      generatedAt: 1,
    })),
  });
  writeJson(join(imageRoot, 'manifest.json'), {
    version: 1,
    entries: sentences.map(sentence => ({
      id: sentence.id,
      textHash: sentence.textHash,
      imageFile: `images/${sentence.id}.webp`,
    })),
  });
  for (const sentence of sentences) {
    writeFileSync(join(imageDirectory, `${sentence.id}.webp`), sentence.id);
  }
  writeJson(analysisOnly, {
    version: 1,
    entries: [{ id: sentences[0].id, textHash: sentences[0].textHash }],
  });
  writeJson(publishedImage, {
    version: 1,
    entries: [{
      id: sentences[1].id,
      textHash: sentences[1].textHash,
      imageFile: `images/${sentences[1].id}.webp`,
    }],
  });

  const result = JSON.parse(execFileSync(process.execPath, [
    resolve('..', 'scripts', 'offline', 'prepare-example-enrichment-wave.mjs'),
    source,
    analysis,
    imageRoot,
    output,
    '10',
    analysisOnly,
    publishedImage,
  ], { encoding: 'utf8' }));
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));

  assert.equal(result.previouslyPublished, 1);
  assert.deepEqual(manifest.entries.map((entry: { id: string }) => entry.id), [
    sentences[0].id,
  ]);
});

test('sentence image preparation reuses a verified baseline image', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-image-fallback-'));
  const sourcePath = join(root, 'source.json');
  const analysisPath = join(root, 'analysis.json');
  const outputRoot = join(root, 'output');
  const fallbackRoot = join(root, 'fallback');
  const id = 'example-reused-image';
  const coveredId = 'example-production-covered-image';
  const filename = `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.webp`;
  mkdirSync(fallbackRoot, { recursive: true });
  writeFileSync(join(fallbackRoot, filename), 'baseline-image');
  writeJson(sourcePath, {
    version: 1,
    sentences: [
      { id, text: 'A reusable image.', textHash: 'text-hash', lookupHash: 'lookup' },
      {
        id: coveredId,
        text: 'Production already has this image.',
        textHash: 'covered-hash',
        lookupHash: 'covered-lookup',
        hasImage: true,
      },
    ],
  });
  writeJson(analysisPath, {
    version: 1,
    generatedAt: 1,
    entries: [
      { id, textHash: 'text-hash', analysis: { imagePrompt: 'A reusable image.' }, generatedAt: 1 },
      {
        id: coveredId,
        textHash: 'covered-hash',
        analysis: { imagePrompt: 'A covered image.' },
        generatedAt: 1,
      },
    ],
  });

  execFileSync(process.execPath, [
    resolve('..', 'scripts', 'offline', 'prepare-sentence-images.mjs'),
    sourcePath,
    analysisPath,
    outputRoot,
    'test-model',
    fallbackRoot,
  ]);

  assert.equal(readFileSync(join(outputRoot, 'images', filename), 'utf8'), 'baseline-image');
  assert.deepEqual(
    JSON.parse(readFileSync(join(outputRoot, 'targets.json'), 'utf8')).targets.map(
      (target: { imageId: string }) => target.imageId,
    ),
    [id],
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(outputRoot, 'manifest.json'), 'utf8')).entries.map(
      (entry: { id: string }) => entry.id,
    ),
    [id],
  );
});
