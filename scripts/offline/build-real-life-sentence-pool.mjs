#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [catalogArg, outputArg, collectionArg, sectionArg] = process.argv.slice(2);
if (!catalogArg || !outputArg) {
  throw new Error(
    'Usage: build-real-life-sentence-pool.mjs <catalog.json> <output.json> [collection-id] [section-id]',
  );
}

const catalog = JSON.parse(readFileSync(resolve(catalogArg), 'utf8'));
if (catalog?.version !== 1 || !Array.isArray(catalog.collections)) {
  throw new Error('Real Life catalog is invalid');
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const normalizeSentence = value => String(value || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2013\u2014]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

const sentences = [];
const seenLookupHashes = new Set();
for (const collection of catalog.collections) {
  if (collectionArg && collection.id !== collectionArg) continue;
  if (!collection?.id || !collection.title || !Array.isArray(collection.sections)) {
    throw new Error('Real Life catalog contains an invalid collection');
  }
  for (const section of collection.sections) {
    if (sectionArg && section.id !== sectionArg) continue;
    if (!section?.id || !section.title || !Array.isArray(section.sentences)) {
      throw new Error(`${collection.id} contains an invalid section`);
    }
    section.sentences.forEach((entry, index) => {
      const text = String(entry?.text || '').trim();
      const focus = String(entry?.focus || '').trim();
      if (!text || !focus || !text.toLocaleLowerCase('en-US').includes(focus.toLocaleLowerCase('en-US'))) {
        throw new Error(`${collection.id}/${section.id} sentence ${index + 1} is invalid`);
      }
      const lookupHash = sha256(normalizeSentence(text));
      if (seenLookupHashes.has(lookupHash)) {
        throw new Error(`${collection.id}/${section.id} duplicates a normalized sentence`);
      }
      seenLookupHashes.add(lookupHash);
      const catalogSentenceId = `${collection.id}:${section.id}:${String(index + 1).padStart(2, '0')}`;
      sentences.push({
        id: `example-${lookupHash.slice(0, 40)}`,
        text,
        sourceWord: focus,
        sourceSense: `${collection.title} — ${section.title}`,
        textHash: sha256(text),
        lookupHash,
        hasAnalysis: false,
        hasImage: false,
        provenance: [{
          catalogSentenceId,
          collectionId: collection.id,
          collectionTitle: collection.title,
          sectionId: section.id,
          sectionTitle: section.title,
        }],
      });
    });
  }
}

if (sentences.length === 0) {
  throw new Error(`No Real Life sentences matched${collectionArg ? ` collection ${collectionArg}` : ''}${sectionArg ? ` section ${sectionArg}` : ''}`);
}

const output = {
  version: 1,
  exportedAt: Date.now(),
  sentences,
  stats: {
    sentences: sentences.length,
    collections: new Set(sentences.map(sentence => sentence.provenance[0].collectionId)).size,
    sections: new Set(sentences.map(sentence =>
      `${sentence.provenance[0].collectionId}:${sentence.provenance[0].sectionId}`)).size,
  },
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(output.stats, null, 2)}\n`);
