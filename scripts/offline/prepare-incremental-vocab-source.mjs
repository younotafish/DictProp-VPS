#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeferred, ledgerFromEnvironment, parentHash, readLedger } from './failure-ledger.mjs';
import { hasCurrentLocalAdvancedEnrichment } from './local-advanced-enrichment.mjs';
import { missingCardFields, validString, validUsageAudit } from './vocab-card-contract.mjs';

const [corpusArg, outputArg, limitArg, lookbackHoursArg, providerFilterArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-vocab-source.mjs <corpus-export.json> <output.json> [limit=8] [lookback-hours=168] [provider-filter]',
  );
}

const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
if (corpus?.version !== 1 || !Array.isArray(corpus.items)) throw new Error('Corpus export is invalid');
const limit = Math.max(1, Math.min(100, Number(limitArg || 8)));
const lookbackHours = Math.max(1, Math.min(24 * 365, Number(lookbackHoursArg || 168)));
const providerFilter = typeof providerFilterArg === 'string' ? providerFilterArg.trim() : '';
const recentSince = Date.now() - lookbackHours * 60 * 60 * 1_000;

const failureLedger = ledgerFromEnvironment('vocab');
const deferredEntries = failureLedger ? readLedger(failureLedger.path).stages[failureLedger.stage] || {} : {};
const now = Date.now();

function shouldArchive(audit) {
  return audit?.confidence !== 'low' &&
    ['british_only', 'rare_or_dated', 'narrow_specialized'].includes(audit?.status);
}

const candidates = [];
let ignoredLegacyExampleOnly = 0;
let missingHeadword = 0;
let deferred = 0;
for (const item of corpus.items) {
  if (!item?.data || item.isDeleted || item.wasArchived || !['vocab', 'phrase'].includes(item.type)) continue;
  const cards = item.type === 'vocab' ? [item.data] : Array.isArray(item.data.vocabs) ? item.data.vocabs : [];
  if (providerFilter && !cards.some(card => card?.advancedEnrichment?.provider === providerFilter)) continue;
  // The completion stage never writes a headword, so selecting such a card would repeat every cycle.
  if (cards.some(card => !validString(card?.word))) {
    missingHeadword++;
    continue;
  }
  const missing = cards.flatMap(card => missingCardFields(card));
  const needsAdvancedEnrichment = cards.some(card => !hasCurrentLocalAdvancedEnrichment(card));
  if (missing.length === 0 && !needsAdvancedEnrichment) continue;
  const recent = Number(item.savedAt || 0) >= recentSince;
  const critical = missing.some(field => field !== 'examples');
  if (!providerFilter && !recent && !critical) {
    ignoredLegacyExampleOnly++;
    continue;
  }
  // A phrase-level usage audit is required by the optimistic corpus importer. Vocabulary cards can
  // have their own missing audit generated below, but an unaudited phrase needs the broader audit job.
  if (item.type === 'phrase' && !validUsageAudit(item.data.usageAudit)) continue;
  if (isDeferred(deferredEntries[item.data.id], parentHash(item), now)) {
    deferred++;
    continue;
  }
  candidates.push({ item, recent, needsAdvancedEnrichment });
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
  wasArchived: item.wasArchived === true,
  data: item.data,
  archiveForUsage: shouldArchive(item.data.usageAudit),
}));
const output = {
  version: 1,
  generatedAt: Date.now(),
  model: 'Incremental vocabulary completion source',
  advancedEnrichmentVersion: 1,
  entries: selected,
};
writeFileSync(resolve(outputArg), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  eligible: candidates.length,
  advancedEligible: candidates.filter(candidate => candidate.needsAdvancedEnrichment).length,
  selected: selected.length,
  ignoredLegacyExampleOnly,
  missingHeadword,
  deferred,
  providerFilter: providerFilter || null,
  recentSince,
})}\n`);
