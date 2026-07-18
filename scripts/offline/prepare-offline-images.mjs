#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [auditArg, outputArg, modelArg] = process.argv.slice(2);
if (!auditArg || !outputArg) {
  throw new Error('Usage: prepare-offline-images.mjs <corpus-audit-manifest.json> <output-directory> [model]');
}

const audit = JSON.parse(readFileSync(resolve(auditArg), 'utf8'));
if (audit?.version !== 1 || !Array.isArray(audit.entries) || audit.entries.length === 0) {
  throw new Error('Corpus audit manifest is invalid or empty');
}

const outputDir = resolve(outputArg);
mkdirSync(join(outputDir, 'images'), { recursive: true });
mkdirSync(join(outputDir, 'candidates'), { recursive: true });

function withoutImages(value) {
  if (Array.isArray(value)) return value.map(withoutImages);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImages(child)]));
}

function sourceHash(data) {
  return createHash('sha256').update(JSON.stringify(withoutImages(data))).digest('hex');
}

function eligible(auditRecord) {
  if (!auditRecord) return true;
  return auditRecord.confidence === 'low' || ['modern_american', 'current_general'].includes(auditRecord.status);
}

function filenameFor(id) {
  return `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.webp`;
}

const imageEntries = [];
const targets = [];
const seen = new Set();
const ordered = [...audit.entries].sort((left, right) => (left.type === 'vocab' ? -1 : 0) - (right.type === 'vocab' ? -1 : 0));

function addTarget(parent, imageId, prompt, learningTarget) {
  if (!imageId || !prompt?.trim() || seen.has(imageId)) return;
  seen.add(imageId);
  const filename = filenameFor(imageId);
  imageEntries.push({
    parentId: parent.id,
    imageId,
    parentHash: sourceHash(parent.data),
    imageFile: `images/${filename}`,
  });
  targets.push({
    imageId,
    filename,
    prompt: prompt.trim(),
    learningTarget,
  });
}

for (const entry of ordered) {
  if (entry.type === 'sentence' || entry.wasArchived || entry.archiveForUsage || !eligible(entry.data?.usageAudit)) continue;
  if (entry.type === 'vocab') {
    addTarget(entry, entry.data.id, entry.data.imagePrompt, {
      kind: 'word sense',
      text: entry.data.word,
      sense: entry.data.sense || '',
      definition: entry.data.definition || '',
    });
    continue;
  }
  addTarget(entry, entry.data.id, entry.data.imagePrompt, {
    kind: 'phrase',
    text: entry.data.query,
    sense: '',
    definition: entry.data.translation || '',
  });
  for (const card of entry.data.vocabs || []) {
    if (!eligible(card.usageAudit)) continue;
    addTarget(entry, card.id, card.imagePrompt, {
      kind: 'word sense',
      text: card.word,
      sense: card.sense || '',
      definition: card.definition || '',
    });
  }
}

const generatedAt = Date.now();
const model = modelArg || 'krea/Krea-2-Turbo';
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
  version: 1,
  generatedAt,
  model,
  entries: imageEntries,
}, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(outputDir, 'targets.json'), `${JSON.stringify({ version: 1, generatedAt, model, targets }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Prepared ${targets.length} active vocabulary/phrase image target(s)\n`);
