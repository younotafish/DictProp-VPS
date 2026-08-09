#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [catalogArg, outputArg, essayArg] = process.argv.slice(2);
if (!catalogArg || !outputArg) {
  throw new Error('Usage: build-essay-sentence-pool.mjs <essay-catalog.json> <output.json> [essay-id[,essay-id...]]');
}

const catalog = JSON.parse(readFileSync(resolve(catalogArg), 'utf8'));
if (catalog?.version !== 1 || !Array.isArray(catalog.essays) || catalog.essays.length === 0) {
  throw new Error('Essay catalog is invalid');
}
const selectedEssayIds = new Set(
  String(essayArg || '').split(',').map(value => value.trim()).filter(Boolean),
);

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

const byLookupHash = new Map();
for (const essay of catalog.essays) {
  if (selectedEssayIds.size > 0 && !selectedEssayIds.has(essay.id)) continue;
  if (!essay?.id || !essay.title || !essay.author || !Array.isArray(essay.paragraphs)) {
    throw new Error('Essay catalog contains an invalid essay');
  }
  const orderedEssaySentences = essay.paragraphs.flatMap(paragraph =>
    paragraph.kind === 'body' && Array.isArray(paragraph.sentences) ? paragraph.sentences : []);
  const contextBySentenceId = new Map(orderedEssaySentences.map((sentence, index) => [
    sentence.id,
    {
      ...(orderedEssaySentences[index - 1]?.text ? { contextBefore: orderedEssaySentences[index - 1].text } : {}),
      ...(orderedEssaySentences[index + 1]?.text ? { contextAfter: orderedEssaySentences[index + 1].text } : {}),
    },
  ]));
  for (const paragraph of essay.paragraphs) {
    if (paragraph.kind !== 'body') continue;
    if (!paragraph.id || !Array.isArray(paragraph.sentences)) {
      throw new Error(`${essay.id} contains an invalid body paragraph`);
    }
    for (const entry of paragraph.sentences) {
      const text = String(entry?.text || '').trim();
      const focus = String(entry?.focus || '').trim();
      if (!entry?.id || !text || !focus ||
          !text.toLocaleLowerCase('en-US').includes(focus.toLocaleLowerCase('en-US'))) {
        throw new Error(`${essay.id}/${paragraph.id} contains an invalid sentence`);
      }
      const lookupHash = sha256(normalizeSentence(text));
      const provenance = {
        essaySentenceId: entry.id,
        essayId: essay.id,
        essayTitle: essay.title,
        author: essay.author,
        paragraphId: paragraph.id,
      };
      const existing = byLookupHash.get(lookupHash);
      if (existing) {
        existing.provenance.push(provenance);
        continue;
      }
      byLookupHash.set(lookupHash, {
        id: `example-${lookupHash.slice(0, 40)}`,
        text,
        sourceWord: focus,
        sourceSense: `${essay.title} — ${essay.author}`,
        ...contextBySentenceId.get(entry.id),
        textHash: sha256(text),
        lookupHash,
        hasAnalysis: false,
        hasImage: false,
        provenance: [provenance],
      });
    }
  }
}

const sentences = [...byLookupHash.values()];
if (sentences.length === 0) {
  throw new Error(`No essay sentences matched${essayArg ? ` selection ${essayArg}` : ''}`);
}
const output = {
  version: 1,
  exportedAt: Date.now(),
  sentences,
  stats: {
    sentences: sentences.length,
    sourceOccurrences: sentences.reduce((count, sentence) => count + sentence.provenance.length, 0),
    essays: new Set(sentences.flatMap(sentence => sentence.provenance.map(value => value.essayId))).size,
  },
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(output.stats, null, 2)}\n`);
