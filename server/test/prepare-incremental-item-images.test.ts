import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { corpusSourceHash } from '../src/corpus-audit.js';
import { repoPath } from './support/paths.js';

const script = repoPath('scripts', 'offline', 'prepare-incremental-item-images.mjs');
const promptHash = (prompt: string) => createHash('sha256').update(prompt.trim()).digest('hex');

interface ImageEntry { parentId: string; imageId: string; parentHash: string; imageFile: string; promptHash: string }

function prepare(items: unknown[], analyses: unknown[], args: string[] = ['krea/Krea-2-Turbo']) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-item-image-hashes-'));
  const corpusPath = join(root, 'corpus.json');
  const analysisPath = join(root, 'analysis.json');
  const output = join(root, 'output');
  writeFileSync(corpusPath, JSON.stringify({ version: 1, exportedAt: Date.now(), items }));
  writeFileSync(analysisPath, JSON.stringify({ version: 1, entries: analyses }));
  const child = spawnSync(process.execPath, [script, corpusPath, analysisPath, '-', output, ...args], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return {
    manifest: JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')),
    targets: JSON.parse(readFileSync(join(output, 'targets.json'), 'utf8')),
  };
}

test('image entries carry the parent hash the importer recomputes, whatever the server leaves out of it', () => {
  // The server's corpus hash ignores a sentence's analysis, its timestamp and its speech style, and every image marker.
  const sentence = {
    id: 'sentence',
    text: 'A sample is ready.',
    sourceWord: 'sample',
    analysis: { imagePrompt: 'A stale prompt the analysis manifest replaces.' },
    analysisGeneratedAt: 5,
    preferredSpeechStyle: 'casual',
  };
  const phrase = {
    id: 'phrase',
    query: 'give up',
    translation: '放弃',
    imagePrompt: 'A runner slowing to a stop at the side of a track, natural light, no text.',
    vocabs: [
      { id: 'covered-card', word: 'give up', imagePrompt: 'A covered card prompt.', imageUrl: 'server:has_image:v1' },
      { id: 'missing-card', word: 'give', imagePrompt: 'A hand passing a parcel to a neighbor across a fence, no text.' },
    ],
  };
  const items = [
    { id: sentence.id, type: 'sentence', savedAt: 1, wasArchived: false, data: sentence },
    { id: phrase.id, type: 'phrase', savedAt: 2, wasArchived: false, data: phrase },
  ];
  const sentencePrompt = 'A realistic photograph of a prepared sample on a clean workbench.';

  const { manifest, targets } = prepare(items, [{ id: sentence.id, analysis: { imagePrompt: sentencePrompt } }]);

  assert.deepEqual(
    targets.targets.map((target: { imageId: string }) => target.imageId),
    ['sentence', 'phrase', 'missing-card'],
  );
  const byImage = new Map<string, ImageEntry>(manifest.entries.map((entry: ImageEntry) => [entry.imageId, entry]));
  assert.equal(byImage.get('sentence')?.parentHash, corpusSourceHash(sentence));
  assert.equal(byImage.get('phrase')?.parentHash, corpusSourceHash(phrase));
  assert.equal(byImage.get('missing-card')?.parentHash, corpusSourceHash(phrase));
  assert.equal(byImage.get('missing-card')?.parentId, 'phrase');
  assert.equal(byImage.get('sentence')?.promptHash, promptHash(sentencePrompt));
  // The style and analysis are left out of the hash, not merely absent from this fixture.
  assert.notEqual(corpusSourceHash(sentence), createHash('sha256').update(JSON.stringify(sentence)).digest('hex'));
});
