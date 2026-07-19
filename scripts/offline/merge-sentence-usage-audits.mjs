#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [corpusArg, auditArg, outputArg] = process.argv.slice(2);
if (!corpusArg || !auditArg || !outputArg) {
  throw new Error('Usage: merge-sentence-usage-audits.mjs <corpus-export.json> <sentence-audit-manifest.json> <output-corpus.json>');
}

const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
const audit = JSON.parse(readFileSync(resolve(auditArg), 'utf8'));
if (!Array.isArray(corpus?.items) || !Array.isArray(audit?.entries)) {
  throw new Error('Corpus export or sentence audit is invalid');
}

const statuses = new Set(['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized']);
const confidences = new Set(['high', 'medium', 'low']);
const itemsById = new Map(corpus.items.map(item => [item.id, item]));
if (itemsById.size !== corpus.items.length) throw new Error('Corpus export contains duplicate ids');
const auditedIds = new Set();
let added = 0;
let preserved = 0;

for (const entry of audit.entries) {
  if (auditedIds.has(entry.id)) throw new Error(`Sentence audit contains duplicate id: ${entry.id}`);
  auditedIds.add(entry.id);
  const item = itemsById.get(entry.id);
  if (!item || item.type !== 'sentence' || entry.type !== 'sentence') {
    throw new Error(`Sentence audit has an unknown or non-sentence id: ${entry.id}`);
  }
  const usageAudit = entry.data?.usageAudit;
  if (!usageAudit || !statuses.has(usageAudit.status) || !confidences.has(usageAudit.confidence) ||
      typeof usageAudit.reason !== 'string' || !usageAudit.reason.trim() ||
      typeof usageAudit.auditedAt !== 'number' || !Number.isFinite(usageAudit.auditedAt)) {
    throw new Error(`Sentence audit is invalid: ${entry.id}`);
  }
  const auditedSourceText = typeof usageAudit.originalText === 'string'
    ? usageAudit.originalText
    : entry.data?.text;
  if (item.data?.text !== auditedSourceText && item.data?.text !== entry.data?.text) {
    throw new Error(`Sentence text changed after usage audit: ${entry.id}`);
  }
  if (item.data.usageAudit) {
    preserved++;
    continue;
  }
  const nextAudit = structuredClone(usageAudit);
  delete nextAudit.originalText;
  item.data = { ...item.data, usageAudit: nextAudit };
  added++;
}

const remaining = corpus.items.filter(item => item.type === 'sentence' && !item.isDeleted && !item.data?.usageAudit);
if (remaining.length > 0) {
  throw new Error(`Corpus still has ${remaining.length} sentence(s) without usage audits: ${remaining.slice(0, 20).map(item => item.id).join(', ')}`);
}

writeFileSync(resolve(outputArg), `${JSON.stringify(corpus, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Added ${added} sentence usage audit(s), preserved ${preserved}, remaining 0\n`);

