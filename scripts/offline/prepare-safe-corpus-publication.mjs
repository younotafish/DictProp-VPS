#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [preliminarySourceArg, analysisWorkArg, finalSourceArg, cacheAuditArg, adjudicationArg, corpusArg, outputArg] = process.argv.slice(2);
if (!preliminarySourceArg || !analysisWorkArg || !finalSourceArg || !cacheAuditArg ||
    !adjudicationArg || !corpusArg || !outputArg) {
  throw new Error('Usage: prepare-safe-corpus-publication.mjs <preliminary-source.json> <analysis-work> <final-source.json> <cache-audit.json> <usage-adjudication.json> <corpus-manifest.json> <output.json>');
}

const preliminary = readJson(preliminarySourceArg);
const finalSource = readJson(finalSourceArg);
const cacheAudit = readJson(cacheAuditArg);
const adjudication = readJson(adjudicationArg);
const corpus = readJson(corpusArg);
if (!Array.isArray(preliminary?.sentences) || !Array.isArray(finalSource?.sentences) ||
    !Array.isArray(cacheAudit?.issues) || !Array.isArray(cacheAudit?.notAmerican) ||
    !Array.isArray(adjudication?.entries) || !Array.isArray(corpus?.entries)) {
  throw new Error('One or more publication inputs are invalid');
}
if (cacheAudit.issues.length > 0) throw new Error(`Analysis cache still has ${cacheAudit.issues.length} issue(s)`);

const analysisWork = resolve(analysisWorkArg);
const workFiles = new Set(readdirSync(analysisWork));
const analyzedIds = new Set();
for (let offset = 0; offset < preliminary.sentences.length; offset += 12) {
  const batch = preliminary.sentences.slice(offset, offset + 12);
  const compact = batch.map(({ text, sourceWord, sourceSense }, itemIndex) => ({ itemIndex, text, sourceWord, sourceSense }));
  const fingerprint = createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 16);
  const file = `batch-${String(offset / 12 + 1).padStart(4, '0')}-${fingerprint}.json`;
  const filePath = join(analysisWork, file);
  if (!workFiles.has(file) || statSync(filePath).mtimeMs > Number(cacheAudit.generatedAt || 0)) continue;
  const result = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(result.results) || result.results.length !== batch.length ||
      new Set(result.results.map(entry => entry.itemIndex)).size !== batch.length) {
    throw new Error(`Cached analysis batch is incomplete: ${file}`);
  }
  for (const sentence of batch) analyzedIds.add(sentence.id);
}

const requirementsByParent = new Map();
for (const sentence of finalSource.sentences) {
  for (const provenance of sentence.provenance || []) {
    if (!requirementsByParent.has(provenance.parentId)) requirementsByParent.set(provenance.parentId, new Set());
    requirementsByParent.get(provenance.parentId).add(sentence.id);
  }
}

const activeStatuses = new Set(['modern_american', 'current_general', 'narrow_specialized']);
const adjudicatedCards = new Set(adjudication.entries.map(entry => `${entry.parentId}\0${entry.cardId}`));
const unresolvedParents = new Set();
for (const sentence of cacheAudit.notAmerican) {
  for (const provenance of sentence.provenance || []) {
    if (activeStatuses.has(provenance.usageStatus) &&
        !adjudicatedCards.has(`${provenance.parentId}\0${provenance.cardId}`)) {
      unresolvedParents.add(provenance.parentId);
    }
  }
}

const entries = corpus.entries.filter(entry => {
  if (!['vocab', 'phrase'].includes(entry.type) || unresolvedParents.has(entry.id)) return false;
  const requirements = requirementsByParent.get(entry.id) || new Set();
  return [...requirements].every(id => analyzedIds.has(id));
});
if (entries.length === 0) throw new Error('No corpus records are safe to publish yet');

const countsByStatus = {};
for (const entry of entries) {
  const status = entry.data?.usageAudit?.status || 'unknown';
  countsByStatus[status] = (countsByStatus[status] || 0) + 1;
}
const output = {
  version: 1,
  generatedAt: corpus.generatedAt,
  model: corpus.model,
  entries,
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  preliminarySentences: preliminary.sentences.length,
  analyzedSentences: analyzedIds.size,
  finalSentences: finalSource.sentences.length,
  unresolvedParents: unresolvedParents.size,
  safeEntries: entries.length,
  countsByStatus,
}, null, 2)}\n`);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}
