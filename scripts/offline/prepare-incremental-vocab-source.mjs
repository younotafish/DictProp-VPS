#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [corpusArg, outputArg, limitArg, lookbackHoursArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-vocab-source.mjs <corpus-export.json> <output.json> [limit=8] [lookback-hours=168]',
  );
}

const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
if (corpus?.version !== 1 || !Array.isArray(corpus.items)) throw new Error('Corpus export is invalid');
const limit = Math.max(1, Math.min(100, Number(limitArg || 8)));
const lookbackHours = Math.max(1, Math.min(24 * 365, Number(lookbackHoursArg || 168)));
const recentSince = Date.now() - lookbackHours * 60 * 60 * 1_000;

const validString = value => typeof value === 'string' && value.trim().length > 0;
const validUsageAudit = value => value && typeof value === 'object' &&
  ['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized']
    .includes(value.status) && validString(value.reason) &&
  ['high', 'medium', 'low'].includes(value.confidence) && Number(value.auditedAt) > 0;
const validExample = value => validString(value) && value.trim().length >= 20 &&
  value.length <= 1_000 && (value.match(/\{\{([^{}]+)\}\}/g) || []).length === 1;

function missingCardFields(card) {
  const missing = [];
  for (const [field, minimum] of [
    ['word', 1], ['sense', 3], ['chinese', 1], ['definition', 10], ['history', 20],
    ['register', 10], ['mnemonic', 10], ['imagePrompt', 50],
  ]) {
    if (!validString(card?.[field]) || card[field].trim().length < minimum) missing.push(field);
  }
  if (validString(card?.chinese) && !/[\u3400-\u9fff]/u.test(card.chinese)) missing.push('chinese');
  if (!/^\/[^/\n]+\/$/.test(String(card?.ipa || '').trim())) missing.push('ipa');
  for (const field of ['forms', 'synonyms', 'antonyms', 'confusables']) {
    if (!Array.isArray(card?.[field]) || card[field].some(value => !validString(value))) missing.push(field);
  }
  if (!Array.isArray(card?.wordFamily) || card.wordFamily.some(member =>
    !validString(member?.word) || !validString(member?.pos) ||
    !validString(member?.chinese) || !/[\u3400-\u9fff]/u.test(member.chinese))) {
    missing.push('wordFamily');
  }
  if (!Array.isArray(card?.examples) || card.examples.length !== 2 || !card.examples.every(validExample)) {
    missing.push('examples');
  }
  if (!validUsageAudit(card?.usageAudit)) missing.push('usageAudit');
  return [...new Set(missing)];
}

function shouldArchive(audit) {
  return audit?.confidence !== 'low' &&
    ['british_only', 'rare_or_dated', 'narrow_specialized'].includes(audit?.status);
}

const candidates = [];
let ignoredLegacyExampleOnly = 0;
for (const item of corpus.items) {
  if (!item?.data || item.isDeleted || item.isArchived || !['vocab', 'phrase'].includes(item.type)) continue;
  const cards = item.type === 'vocab' ? [item.data] : Array.isArray(item.data.vocabs) ? item.data.vocabs : [];
  const missing = cards.flatMap(card => missingCardFields(card));
  if (missing.length === 0) continue;
  const recent = Number(item.savedAt || 0) >= recentSince;
  const critical = missing.some(field => field !== 'examples');
  if (!recent && !critical) {
    ignoredLegacyExampleOnly++;
    continue;
  }
  // A phrase-level usage audit is required by the optimistic corpus importer. Vocabulary cards can
  // have their own missing audit generated below, but an unaudited phrase needs the broader audit job.
  if (item.type === 'phrase' && !validUsageAudit(item.data.usageAudit)) continue;
  candidates.push({ item, recent });
}

candidates.sort((left, right) =>
  Number(right.recent) - Number(left.recent) ||
  Number(left.item.savedAt || 0) - Number(right.item.savedAt || 0) ||
  String(left.item.data.id).localeCompare(String(right.item.data.id))
);

const selected = candidates.slice(0, limit).map(({ item }) => ({
  id: item.data.id,
  type: item.type,
  sourceHash: item.sourceHash,
  wasArchived: item.isArchived === true,
  data: item.data,
  archiveForUsage: shouldArchive(item.data.usageAudit),
}));
const output = {
  version: 1,
  generatedAt: Date.now(),
  model: 'local incremental vocabulary completion source',
  entries: selected,
};
writeFileSync(resolve(outputArg), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  eligible: candidates.length,
  selected: selected.length,
  ignoredLegacyExampleOnly,
  recentSince,
})}\n`);
