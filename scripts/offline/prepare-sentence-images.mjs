#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [sentenceExportArg, analysisArg, outputArg, modelArg, ...fallbackImageDirArgs] = process.argv.slice(2);
if (!sentenceExportArg || !analysisArg || !outputArg) {
  throw new Error(
    'Usage: prepare-sentence-images.mjs <sentence-export.json> <analysis-manifest.json> <output-directory> [model] [fallback-image-directory]...',
  );
}

const sentenceExport = JSON.parse(readFileSync(resolve(sentenceExportArg), 'utf8'));
const analysis = JSON.parse(readFileSync(resolve(analysisArg), 'utf8'));
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
  const filename = `${createHash('sha256').update(entry.id).digest('hex').slice(0, 32)}.webp`;
  const destination = join(outputImageDir, filename);
  if (!existsSync(destination)) {
    for (const fallbackImageDir of fallbackImageDirs) {
      const fallback = join(fallbackImageDir, filename);
      if (!existsSync(fallback)) continue;
      try {
        linkSync(fallback, destination);
      } catch {
        copyFileSync(fallback, destination);
      }
      break;
    }
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
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({ ...analysis, entries }, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(outputDir, 'targets.json'), `${JSON.stringify({
  version: 1,
  generatedAt: analysis.generatedAt,
  model,
  targets,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Prepared ${targets.length} sentence image target(s)\n`);
