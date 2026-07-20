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
