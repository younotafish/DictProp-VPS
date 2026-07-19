#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [corpusArg, outputArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error('Usage: build-missing-sentence-export.mjs <corpus.json> <sentence-export.json>');
}

const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
if (!Array.isArray(corpus?.items)) throw new Error('Corpus export is invalid');
const sentences = corpus.items
  .filter(item => item?.type === 'sentence' && !item.isDeleted && !item.data?.analysis)
  .map(item => {
    const data = item.data || {};
    if (typeof data.id !== 'string' || !data.id || typeof data.text !== 'string' || !data.text.trim()) {
      throw new Error('Corpus contains an invalid sentence');
    }
    return {
      id: data.id,
      text: data.text,
      sourceWord: typeof data.sourceWord === 'string' ? data.sourceWord : '',
      ...(typeof data.sourceSense === 'string' ? { sourceSense: data.sourceSense } : {}),
      textHash: createHash('sha256').update(data.text).digest('hex'),
      hasAnalysis: false,
      hasImage: data.imageUrl === 'server:has_image' ||
        (typeof data.imageUrl === 'string' && data.imageUrl.startsWith('data:image/')),
    };
  });

if (sentences.length === 0) throw new Error('Corpus has no sentences missing analysis');
writeFileSync(resolve(outputArg), `${JSON.stringify({ version: 1, exportedAt: Date.now(), sentences }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Prepared ${sentences.length} sentence(s) missing analysis\n`);

