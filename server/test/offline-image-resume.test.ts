import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
