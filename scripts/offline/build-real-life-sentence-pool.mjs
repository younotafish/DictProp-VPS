#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readJson, writePrivateJson } from './offline-io.mjs';
import { poolSentence, sentenceLookupHash } from './sentence-pool.mjs';

const [catalogArg, outputArg, collectionArg, sectionArg] = process.argv.slice(2);
if (!catalogArg || !outputArg) {
  throw new Error(
    'Usage: build-real-life-sentence-pool.mjs <catalog.json> <output.json> [collection-id[,collection-id...]] [section-id]',
  );
}

const catalog = readJson(catalogArg);
if (catalog?.version !== 1 || !Array.isArray(catalog.collections)) {
  throw new Error('Real Life catalog is invalid');
}
const selectedCollectionIds = new Set(
  String(collectionArg || '').split(',').map(value => value.trim()).filter(Boolean),
);

const sentences = [];
const seenLookupHashes = new Set();
for (const collection of catalog.collections) {
  if (!collection?.id || !collection.title || !Array.isArray(collection.sections)) {
    throw new Error('Real Life catalog contains an invalid collection');
  }
  if (selectedCollectionIds.size > 0 && !selectedCollectionIds.has(collection.id)) continue;
  for (const section of collection.sections) {
    if (!section?.id || !section.title || !Array.isArray(section.sentences)) {
      throw new Error(`${collection.id} contains an invalid section`);
    }
    if (sectionArg && section.id !== sectionArg) continue;
    section.sentences.forEach((entry, index) => {
      const text = String(entry?.text || '').trim();
      const focus = String(entry?.focus || '').trim();
      if (!text || !focus || !text.toLocaleLowerCase('en-US').includes(focus.toLocaleLowerCase('en-US'))) {
        throw new Error(`${collection.id}/${section.id} sentence ${index + 1} is invalid`);
      }
      // The line's own id, as the app and the server read it (services/realLifeCatalog.ts), never its position.
      if (typeof entry.id !== 'string' || !entry.id.trim()) {
        throw new Error(`${collection.id}/${section.id} sentence ${index + 1} has no id`);
      }
      const lookupHash = sentenceLookupHash(text);
      if (seenLookupHashes.has(lookupHash)) {
        throw new Error(`${collection.id}/${section.id} duplicates a normalized sentence`);
      }
      seenLookupHashes.add(lookupHash);
      const catalogSentenceId = `${collection.id}:${section.id}:${entry.id}`;
      sentences.push(poolSentence({
        text,
        lookupHash,
        sourceWord: focus,
        sourceSense: `${collection.title} — ${section.title}`,
        provenance: {
          catalogSentenceId,
          collectionId: collection.id,
          collectionTitle: collection.title,
          sectionId: section.id,
          sectionTitle: section.title,
        },
      }));
    });
  }
}

if (sentences.length === 0) {
  throw new Error(`No Real Life sentences matched${collectionArg ? ` collection selection ${collectionArg}` : ''}${sectionArg ? ` section ${sectionArg}` : ''}`);
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
writePrivateJson(outputPath, output);
process.stdout.write(`${JSON.stringify(output.stats, null, 2)}\n`);
