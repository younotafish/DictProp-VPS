#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [sourceArg, outputArg, ...manifestArgs] = process.argv.slice(2);
if (!sourceArg || !outputArg || manifestArgs.length < 1) {
  throw new Error('Usage: merge-reviewed-natural-ipa.mjs <source.json> <output.json> <manifest.json>...');
}

const source = JSON.parse(readFileSync(resolve(sourceArg), 'utf8'));
let sentences;
if (source?.version === 1 && Array.isArray(source.sentences)) {
  sentences = source.sentences;
} else if (Array.isArray(source?.items)) {
  sentences = source.items
    .filter(item => item?.type === 'sentence' && !item.isDeleted)
    .map(item => item.data);
} else {
  throw new Error('Sentence source is invalid');
}

const sourceById = new Map();
for (const sentence of sentences) {
  if (typeof sentence?.id !== 'string' || !sentence.id || typeof sentence.text !== 'string' || !sentence.text.trim()) {
    throw new Error('Sentence source contains an invalid record');
  }
  if (sourceById.has(sentence.id)) throw new Error(`Duplicate sentence id: ${sentence.id}`);
  sourceById.set(sentence.id, sentence);
}

const entryById = new Map();
const models = [];
let generatedAt = 0;
for (const manifestArg of manifestArgs) {
  const manifest = JSON.parse(readFileSync(resolve(manifestArg), 'utf8'));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`Invalid IPA manifest: ${manifestArg}`);
  }
  models.push(String(manifest.model || 'unknown'));
  generatedAt = Math.max(generatedAt, Number(manifest.generatedAt || 0));
  for (const entry of manifest.entries) {
    const sourceSentence = sourceById.get(entry?.id);
    if (!sourceSentence) throw new Error(`Unknown IPA entry: ${entry?.id || 'missing id'}`);
    if (entryById.has(entry.id)) throw new Error(`Duplicate IPA entry across manifests: ${entry.id}`);
    const expectedHash = createHash('sha256').update(sourceSentence.text).digest('hex');
    if (entry.textHash !== expectedHash) throw new Error(`Stale IPA entry: ${entry.id}`);
    const ipa = typeof entry.naturalSpeechIpa === 'string' ? entry.naturalSpeechIpa.trim() : '';
    if (!/^\/[^/\n]+\/$/.test(ipa) || /[\[\]{}<>`0-9A-Z]/.test(ipa) || /əʊ|ɜː|ɒ/.test(ipa)) {
      throw new Error(`Invalid IPA entry: ${entry.id}`);
    }
    entryById.set(entry.id, { ...entry, naturalSpeechIpa: ipa });
  }
}

if (entryById.size !== sentences.length) {
  throw new Error(`Merged IPA count ${entryById.size} does not match source count ${sentences.length}`);
}
const entries = sentences.map(sentence => entryById.get(sentence.id));
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({
  version: 1,
  model: `cross-reviewed:merged:${models.join('+')}`,
  models,
  generatedAt: generatedAt || Date.now(),
  entries,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Merged ${entries.length} reviewed sentence IPA records\n`);
