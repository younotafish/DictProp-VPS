import { execFileSync } from 'node:child_process';
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

test('example enrichment publication excludes only current image-bearing entries', () => {
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
    sentences[2].id,
  ]);
});
