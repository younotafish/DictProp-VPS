#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [auditArg, outputArg] = process.argv.slice(2);
if (!auditArg || !outputArg) {
  throw new Error('Usage: build-sentence-export-from-audit.mjs <final-audit.json> <sentence-export.json>');
}

const audit = JSON.parse(readFileSync(resolve(auditArg), 'utf8'));
if (audit?.version !== 1 || !Array.isArray(audit.entries) || audit.entries.length === 0) {
  throw new Error('Corpus audit manifest is invalid or empty');
}

const sentences = audit.entries
  .filter(entry => entry.type === 'sentence')
  .map(entry => {
    const data = entry.data || {};
    if (data.id !== entry.id || typeof data.text !== 'string' || !data.text.trim()) {
      throw new Error(`Invalid audited sentence ${entry.id}`);
    }
    const text = data.text;
    return {
      id: entry.id,
      text,
      sourceWord: typeof data.sourceWord === 'string' ? data.sourceWord : '',
      ...(typeof data.sourceSense === 'string' ? { sourceSense: data.sourceSense } : {}),
      textHash: createHash('sha256').update(text).digest('hex'),
      hasAnalysis: !!data.analysis,
      hasImage: data.imageUrl === 'server:has_image' ||
        (typeof data.imageUrl === 'string' && data.imageUrl.startsWith('data:image/')),
    };
  });

if (sentences.length === 0) throw new Error('Corpus audit contains no sentences');
writeFileSync(resolve(outputArg), `${JSON.stringify({
  version: 1,
  exportedAt: Date.now(),
  sentences,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Prepared ${sentences.length} audited sentence record(s)\n`);
