import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { poolSentence, sentenceImageFilename, sentenceLookupHash } from '../../scripts/offline/sentence-pool.mjs';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'prepare-sentence-images.mjs');

const sentence = (text: string, hasImage = false) => poolSentence({
  text,
  lookupHash: sentenceLookupHash(text),
  sourceWord: 'example',
  sourceSense: 'noun: an instance',
  provenance: { parentId: 'card' },
  hasImage,
});
const analysisFor = (prompt: string) => ({ translation: `译文 ${prompt}`, imagePrompt: prompt });

// `images` are files the bundle's images/ already holds, by name, as an earlier cycle can leave them.
function prepare(
  sentences: Array<ReturnType<typeof sentence>>, analysis: unknown, fallback?: string, model = 'test-model',
  images: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-sentence-images-'));
  writeJson(join(root, 'source.json'), { version: 1, sentences });
  writeJson(join(root, 'analysis.json'), analysis);
  const output = join(root, 'bundle');
  mkdirSync(join(output, 'images'), { recursive: true });
  for (const [name, content] of Object.entries(images)) writeFileSync(join(output, 'images', name), content);
  const args = [script, join(root, 'source.json'), join(root, 'analysis.json'), output];
  if (model || fallback) args.push(model);
  if (fallback) args.push(fallback);
  const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const read = (name: string) => JSON.parse(readFileSync(join(output, name), 'utf8'));
  return { child, output, read };
}

test('sentence images: targets for the sentences production lacks, and a manifest of their identities and files', () => {
  const missing = sentence('This {{example}} still needs an image.');
  const covered = sentence('This {{example}} already has one.', true);
  const reused = sentence('This {{example}} was rendered for the baseline.');
  const fallback = mkdtempSync(join(tmpdir(), 'dictprop-sentence-image-fallback-'));
  writeFileSync(join(fallback, sentenceImageFilename(reused.id)), 'baseline render');
  const analysis = {
    version: 1,
    generatedAt: 42,
    model: 'analysis model',
    entries: [missing, covered, reused].map((value, index) => ({
      id: value.id, textHash: value.textHash, analysis: analysisFor(`Prompt ${index}`), generatedAt: index + 1,
    })),
  };

  const { child, output, read } = prepare([missing, covered, reused], analysis, fallback);

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(read('manifest.json'), {
    version: 1,
    generatedAt: 42,
    entries: [missing, reused].map(value => ({
      id: value.id, textHash: value.textHash, imageFile: `images/${sentenceImageFilename(value.id)}`,
    })),
  });
  assert.deepEqual(read('targets.json'), {
    version: 1,
    generatedAt: 42,
    model: 'test-model',
    targets: [
      {
        imageId: missing.id,
        filename: sentenceImageFilename(missing.id),
        prompt: 'Prompt 0',
        learningTarget: { kind: 'sentence', text: missing.text, sense: missing.sourceSense, definition: '译文 Prompt 0' },
      },
      {
        imageId: reused.id,
        filename: sentenceImageFilename(reused.id),
        prompt: 'Prompt 2',
        learningTarget: { kind: 'sentence', text: reused.text, sense: reused.sourceSense, definition: '译文 Prompt 2' },
      },
    ],
  });
  assert.equal(readFileSync(join(output, 'images', sentenceImageFilename(reused.id)), 'utf8'), 'baseline render');
});

test('sentence images take an empty file for a missing image, in the bundle and in a fallback directory', () => {
  const replaced = sentence('An empty file stands where this {{example}} image belongs.');
  const removed = sentence('An empty file stands where this other {{example}} image belongs.');
  const notLinked = sentence('The baseline file for this {{example}} is empty.');
  const fallback = mkdtempSync(join(tmpdir(), 'dictprop-sentence-image-fallback-'));
  writeFileSync(join(fallback, sentenceImageFilename(replaced.id)), 'baseline render');
  writeFileSync(join(fallback, sentenceImageFilename(notLinked.id)), '');
  const analysis = {
    version: 1,
    generatedAt: 1,
    entries: [replaced, removed, notLinked].map(value => ({
      id: value.id, textHash: value.textHash, analysis: analysisFor('Prompt'), generatedAt: 1,
    })),
  };

  const { child, output } = prepare([replaced, removed, notLinked], analysis, fallback, 'test-model', {
    [sentenceImageFilename(replaced.id)]: '',
    [sentenceImageFilename(removed.id)]: '',
  });

  assert.equal(child.status, 0, child.stderr);
  // The baseline's render replaces an empty file; with no render to take its place, the empty file goes, so
  // the verifier and the dispatcher count the image as missing (deferred) instead of failing on it.
  assert.equal(readFileSync(join(output, 'images', sentenceImageFilename(replaced.id)), 'utf8'), 'baseline render');
  assert.equal(existsSync(join(output, 'images', sentenceImageFilename(removed.id))), false);
  assert.equal(existsSync(join(output, 'images', sentenceImageFilename(notLinked.id))), false);
  assert.equal(readFileSync(join(fallback, sentenceImageFilename(notLinked.id)), 'utf8'), '');
});

test('sentence images refuse an analysis written for different text', () => {
  const value = sentence('The {{example}} text changed.');
  const { child } = prepare([value], {
    version: 1,
    generatedAt: 1,
    entries: [{ id: value.id, textHash: 'an older text', analysis: analysisFor('Prompt'), generatedAt: 1 }],
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, new RegExp(`Sentence source mismatch: ${value.id}`));
});

test('without a model label, sentence image targets name the loop\'s default renderer, Krea', () => {
  const value = sentence('The {{example}} needs a render.');
  const { child, read } = prepare([value], {
    version: 1,
    generatedAt: 1,
    entries: [{ id: value.id, textHash: value.textHash, analysis: analysisFor('Prompt'), generatedAt: 1 }],
  }, undefined, '');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(read('targets.json').model, 'krea/Krea-2-Turbo');
});
