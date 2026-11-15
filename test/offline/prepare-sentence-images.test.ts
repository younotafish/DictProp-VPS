import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function prepare(sentences: Array<ReturnType<typeof sentence>>, analysis: unknown, fallback?: string) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-sentence-images-'));
  writeJson(join(root, 'source.json'), { version: 1, sentences });
  writeJson(join(root, 'analysis.json'), analysis);
  const output = join(root, 'bundle');
  const args = [script, join(root, 'source.json'), join(root, 'analysis.json'), output, 'test-model'];
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
