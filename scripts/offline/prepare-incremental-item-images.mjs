#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { corpusSourceHash } from '../../server/src/corpus-hash.ts';
import {
  hasCurrentLocalAdvancedEnrichment,
  hasCurrentLocalImageEnrichment,
  imagePromptHash,
} from '../../server/src/local-enrichment-markers.ts';
import { DEFAULT_IMAGE_MODEL_LABEL } from './image-model.mjs';
import { readJson, writePrivateJson } from './offline-io.mjs';

const [corpusArg, analysisArg, completionArg, outputArg, modelArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-item-images.mjs <corpus-export.json> <sentence-analysis.json|-> <vocab-completion.json|-> <output-directory> [model]',
  );
}

const corpus = readJson(corpusArg);
if (corpus?.version !== 1 || !Array.isArray(corpus.items)) throw new Error('Corpus export is invalid');
const sentenceAnalysisById = new Map();
if (analysisArg && analysisArg !== '-') {
  const analyses = readJson(analysisArg);
  if (analyses?.version !== 1 || !Array.isArray(analyses.entries)) {
    throw new Error('Sentence analysis manifest is invalid');
  }
  for (const entry of analyses.entries) sentenceAnalysisById.set(entry.id, entry.analysis);
}
const completedDataById = new Map();
if (completionArg && completionArg !== '-') {
  const completion = readJson(completionArg);
  if (completion?.version !== 1 || !Array.isArray(completion.entries)) {
    throw new Error('Vocabulary completion manifest is invalid');
  }
  for (const entry of completion.entries) completedDataById.set(entry.id, entry.data);
}
const outputDir = resolve(outputArg);
mkdirSync(join(outputDir, 'images'), { recursive: true });
mkdirSync(join(outputDir, 'candidates'), { recursive: true });
const model = modelArg || DEFAULT_IMAGE_MODEL_LABEL;
const entries = [];
const targets = [];
const seen = new Set();

function filenameFor(id, prompt) {
  return `${createHash('sha256').update(`${id}\0${prompt}`).digest('hex').slice(0, 32)}.webp`;
}

function addTarget(parent, imageId, prompt, learningTarget) {
  if (!imageId || !prompt?.trim() || seen.has(imageId)) return;
  seen.add(imageId);
  const filename = filenameFor(imageId, prompt.trim());
  entries.push({
    parentId: parent.data.id,
    imageId,
    parentHash: corpusSourceHash(parent.data),
    imageFile: `images/${filename}`,
    promptHash: imagePromptHash(prompt),
  });
  targets.push({ imageId, filename, prompt: prompt.trim(), learningTarget });
}

for (const item of corpus.items) {
  // Production does not count archived items as gaps; the corpus export records them as wasArchived.
  if (!item?.data || item.isDeleted || item.wasArchived) continue;
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
    const needsLocalImage = hasCurrentLocalAdvancedEnrichment(data) && !hasCurrentLocalImageEnrichment(data);
    if (!data.imageUrl || needsLocalImage) {
      addTarget(effectiveItem, data.id, data.imagePrompt, {
        kind: 'word sense', text: data.word, sense: data.sense || '', definition: data.definition || '',
      });
    }
  } else if (item.type === 'phrase') {
    const hasLocallyAdvancedCard = (data.vocabs || []).some(hasCurrentLocalAdvancedEnrichment);
    const needsLocalPhraseImage = hasLocallyAdvancedCard && !hasCurrentLocalImageEnrichment(data);
    if (!data.imageUrl || needsLocalPhraseImage) {
      addTarget(effectiveItem, data.id, data.imagePrompt, {
        kind: 'phrase', text: data.query, sense: '', definition: data.translation || '',
      });
    }
    for (const card of data.vocabs || []) {
      const needsLocalImage = hasCurrentLocalAdvancedEnrichment(card) && !hasCurrentLocalImageEnrichment(card);
      if (!card?.imageUrl || needsLocalImage) {
        addTarget(effectiveItem, card?.id, card?.imagePrompt, {
          kind: 'word sense', text: card?.word, sense: card?.sense || '', definition: card?.definition || '',
        });
      }
    }
  }
}

const generatedAt = Date.now();
writePrivateJson(join(outputDir, 'manifest.json'), { version: 1, generatedAt, model, entries });
writePrivateJson(join(outputDir, 'targets.json'), { version: 1, generatedAt, model, targets });
process.stderr.write(`Prepared ${targets.length} missing or locally refreshed top-level/nested item image target(s)\n`);
