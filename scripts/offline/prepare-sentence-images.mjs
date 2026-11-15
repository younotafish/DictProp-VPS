#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { linkOrCopy, readJson, writePrivateJson } from './offline-io.mjs';
import { sentenceImageFilename } from './sentence-pool.mjs';

const [sentenceExportArg, analysisArg, outputArg, modelArg, ...fallbackImageDirArgs] = process.argv.slice(2);
if (!sentenceExportArg || !analysisArg || !outputArg) {
  throw new Error(
    'Usage: prepare-sentence-images.mjs <sentence-export.json> <analysis-manifest.json> <output-directory> [model] [fallback-image-directory]...',
  );
}

const sentenceExport = readJson(sentenceExportArg);
const analysis = readJson(analysisArg);
if (sentenceExport?.version !== 1 || !Array.isArray(sentenceExport.sentences) ||
    analysis?.version !== 1 || !Array.isArray(analysis.entries)) {
  throw new Error('Sentence export or analysis manifest is invalid');
}
const sources = new Map(sentenceExport.sentences.map(sentence => [sentence.id, sentence]));
const outputDir = resolve(outputArg);
const outputImageDir = join(outputDir, 'images');
const fallbackImageDirs = fallbackImageDirArgs.map(path => resolve(path));
mkdirSync(outputImageDir, { recursive: true });
mkdirSync(join(outputDir, 'candidates'), { recursive: true });

const targets = [];
const entries = analysis.entries.filter(entry => sources.get(entry.id)?.hasImage !== true).map(entry => {
  const source = sources.get(entry.id);
  if (!source || source.textHash !== entry.textHash) throw new Error(`Sentence source mismatch: ${entry.id}`);
  const filename = sentenceImageFilename(entry.id);
  const destination = join(outputImageDir, filename);
  if (!existsSync(destination)) {
    const fallback = fallbackImageDirs.map(directory => join(directory, filename)).find(path => existsSync(path));
    if (fallback) linkOrCopy(fallback, destination);
  }
  targets.push({
    imageId: entry.id,
    filename,
    prompt: entry.analysis.imagePrompt,
    learningTarget: {
      kind: 'sentence',
      text: source.text,
      sense: source.sourceSense || '',
      definition: entry.analysis.translation,
    },
  });
  return { ...entry, imageFile: `images/${filename}`, replaceImage: true };
});

const model = modelArg || 'krea/Krea-2-Turbo';
writePrivateJson(join(outputDir, 'manifest.json'), { ...analysis, entries });
writePrivateJson(join(outputDir, 'targets.json'), {
  version: 1,
  generatedAt: analysis.generatedAt,
  model,
  targets,
});
process.stderr.write(`Prepared ${targets.length} sentence image target(s)\n`);
