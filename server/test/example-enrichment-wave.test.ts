import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { sentenceLookupHash } from '../src/sentence-enrichment.js';

const analysis = {
  translation: 'translation',
  naturalSpeechIpa: '/nætʃərəl spiːtʃ/',
  americanEnglish: { status: 'shared', explanation: 'Natural shared English.' },
  terms: [],
  imagePrompt: 'A realistic photograph illustrating the sentence without text.',
};

function sentence(text: string) {
  const lookupHash = sentenceLookupHash(text);
  return {
    id: `example-${lookupHash.slice(0, 40)}`,
    text,
    lookupHash,
    textHash: createHash('sha256').update(text).digest('hex'),
    sourceWord: 'test',
    provenance: [{ parentId: 'parent', parentType: 'vocab' }],
  };
}

test('example enrichment waves are bounded, resumable, and copy only ready images', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-enrichment-wave-'));
  const imageRoot = join(root, 'image-bundle');
  const output = join(root, 'wave');
  mkdirSync(join(imageRoot, 'images'), { recursive: true });
  const first = sentence('The first [[example]] is ready.');
  const second = sentence('The second [[example]] is ready.');
  const entries = [first, second].map((value, index) => ({
    id: value.id,
    textHash: value.textHash,
    analysis,
    generatedAt: index + 1,
  }));
  const imageEntries = entries.map((value, index) => ({
    ...value,
    imageFile: `images/${index + 1}.webp`,
  }));
  for (let index = 0; index < imageEntries.length; index++) {
    writeFileSync(join(imageRoot, imageEntries[index].imageFile), Buffer.from(`image-${index}`));
  }
  const sourcePath = join(root, 'source.json');
  const analysisPath = join(root, 'analysis.json');
  const excludedPath = join(root, 'published.json');
  writeFileSync(sourcePath, JSON.stringify({ version: 1, sentences: [first, second] }));
  writeFileSync(analysisPath, JSON.stringify({ version: 1, entries }));
  writeFileSync(join(imageRoot, 'manifest.json'), JSON.stringify({ version: 1, entries: imageEntries }));
  writeFileSync(excludedPath, JSON.stringify({ version: 1, entries: [{ id: first.id }] }));

  const stdout = execFileSync(process.execPath, [
    resolve('..', 'scripts/offline/prepare-example-enrichment-wave.mjs'),
    sourcePath,
    analysisPath,
    imageRoot,
    output,
    '1',
    excludedPath,
  ], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(stdout), { sourceEntries: 2, previouslyPublished: 1, waveEntries: 1 });
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].id, second.id);
  assert.equal(manifest.entries[0].lookupHash, second.lookupHash);
  assert.equal(readFileSync(join(output, manifest.entries[0].imageFile), 'utf8'), 'image-1');
});
