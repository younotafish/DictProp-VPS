#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [corpusArg, analysisArg, completionArg, outputArg, modelArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-item-images.mjs <corpus-export.json> <sentence-analysis.json|-> <vocab-completion.json|-> <output-directory> [model]',
  );
}

const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
if (corpus?.version !== 1 || !Array.isArray(corpus.items)) throw new Error('Corpus export is invalid');
const sentenceAnalysisById = new Map();
if (analysisArg && analysisArg !== '-') {
  const analyses = JSON.parse(readFileSync(resolve(analysisArg), 'utf8'));
  if (analyses?.version !== 1 || !Array.isArray(analyses.entries)) {
    throw new Error('Sentence analysis manifest is invalid');
  }
  for (const entry of analyses.entries) sentenceAnalysisById.set(entry.id, entry.analysis);
}
const completedDataById = new Map();
if (completionArg && completionArg !== '-') {
  const completion = JSON.parse(readFileSync(resolve(completionArg), 'utf8'));
  if (completion?.version !== 1 || !Array.isArray(completion.entries)) {
    throw new Error('Vocabulary completion manifest is invalid');
  }
  for (const entry of completion.entries) completedDataById.set(entry.id, entry.data);
}

const outputDir = resolve(outputArg);
mkdirSync(join(outputDir, 'images'), { recursive: true });
mkdirSync(join(outputDir, 'candidates'), { recursive: true });
const model = modelArg || 'baidu/ERNIE-Image-Turbo';
const entries = [];
const targets = [];
const seen = new Set();

function withoutImages(value) {
  if (Array.isArray(value)) return value.map(withoutImages);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImages(child)]));
}

function parentHash(data) {
  const stable = Object.fromEntries(Object.entries(data).filter(([key]) =>
    key !== 'analysis' && key !== 'analysisGeneratedAt' && key !== 'preferredSpeechStyle'));
  return createHash('sha256').update(JSON.stringify(withoutImages(stable))).digest('hex');
}

function filenameFor(id) {
  return `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.webp`;
}

function addTarget(parent, imageId, prompt, learningTarget) {
  if (!imageId || !prompt?.trim() || seen.has(imageId)) return;
  seen.add(imageId);
  const filename = filenameFor(imageId);
  entries.push({
    parentId: parent.data.id,
    imageId,
    parentHash: parentHash(parent.data),
    imageFile: `images/${filename}`,
  });
  targets.push({ imageId, filename, prompt: prompt.trim(), learningTarget });
}

for (const item of corpus.items) {
  if (!item?.data || item.isDeleted || item.isArchived) continue;
  const data = completedDataById.get(item.data.id) || item.data;
  const effectiveItem = data === item.data ? item : { ...item, data };
  if (item.type === 'sentence') {
    const analysis = sentenceAnalysisById.get(data.id) || data.analysis;
    if (!data.imageUrl) {
      addTarget(effectiveItem, data.id, analysis?.imagePrompt, {
        kind: 'saved sentence',
        text: data.text,
        sense: data.sourceSense || '',
        definition: data.sourceWord || '',
      });
    }
  } else if (item.type === 'vocab') {
    if (!data.imageUrl) {
      addTarget(effectiveItem, data.id, data.imagePrompt, {
        kind: 'word sense', text: data.word, sense: data.sense || '', definition: data.definition || '',
      });
    }
  } else if (item.type === 'phrase') {
    if (!data.imageUrl) {
      addTarget(effectiveItem, data.id, data.imagePrompt, {
        kind: 'phrase', text: data.query, sense: '', definition: data.translation || '',
      });
    }
    for (const card of data.vocabs || []) {
      if (!card?.imageUrl) {
        addTarget(effectiveItem, card?.id, card?.imagePrompt, {
          kind: 'word sense', text: card?.word, sense: card?.sense || '', definition: card?.definition || '',
        });
      }
    }
  }
}

const generatedAt = Date.now();
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
  version: 1, generatedAt, model, entries,
}, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(outputDir, 'targets.json'), `${JSON.stringify({
  version: 1, generatedAt, model, targets,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Prepared ${targets.length} missing top-level/nested item image target(s)\n`);
