#!/usr/bin/env node

import { isUsageAudit, shouldArchiveUsage } from '../../server/src/shared/usage-audit.ts';
import { isDeferred, ledgerFromEnvironment, parentHash, readLedger } from './failure-ledger.mjs';
import { hasCurrentLocalAdvancedEnrichment } from './local-advanced-enrichment.mjs';
import { readJson, writePrivateJson } from './offline-io.mjs';
import { missingCardFields, validString, validUsageAudit } from './vocab-card-contract.mjs';

const [corpusArg, outputArg, limitArg, lookbackHoursArg, providerFilterArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-vocab-source.mjs <corpus-export.json> <output.json> [limit=8] [lookback-hours=168] [provider-filter]',
  );
}

const corpus = readJson(corpusArg);
if (corpus?.version !== 1 || !Array.isArray(corpus.items)) throw new Error('Corpus export is invalid');
// A knob that isn't an integer would select nothing (slice(0, NaN) is empty) and look like a quiet cycle.
function integerArg(name, raw, fallback, min, max) {
  const value = Number(raw || fallback);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, not ${JSON.stringify(raw)}`);
  return Math.max(min, Math.min(max, value));
}
const limit = integerArg('limit', limitArg, 8, 1, 100);
const lookbackHours = integerArg('lookback-hours', lookbackHoursArg, 168, 1, 24 * 365);
const providerFilter = typeof providerFilterArg === 'string' ? providerFilterArg.trim() : '';
const recentSince = Date.now() - lookbackHours * 60 * 60 * 1_000;

const failureLedger = ledgerFromEnvironment('vocab');
const deferredEntries = failureLedger ? readLedger(failureLedger.path).stages[failureLedger.stage] || {} : {};
const now = Date.now();

// Whether the corpus importer archives an item for its usage audit; it refuses an entry that says otherwise.
const shouldArchive = audit => isUsageAudit(audit) && shouldArchiveUsage(audit.status, audit.confidence);

const candidates = [];
let ignoredOlderNonCritical = 0;
let missingHeadword = 0;
let unauditedPhrases = 0;
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
  // An older card is left alone when all it lacks is two well-formed examples or the advanced rewrite.
  if (!providerFilter && !recent && !critical) {
    ignoredOlderNonCritical++;
    continue;
  }
  // The corpus importer requires a phrase-level usage audit, and completion writes only card-level ones. The bulk job
  // that wrote phrase audits is gone, and the app has saved searched phrases as vocab items since January 2026, so
  // only legacy phrases land here.
  if (item.type === 'phrase' && !validUsageAudit(item.data.usageAudit)) {
    unauditedPhrases++;
    continue;
  }
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
  // Archived items never become candidates, and the importer requires the field.
  wasArchived: false,
  data: item.data,
  archiveForUsage: shouldArchive(item.data.usageAudit),
}));
const output = {
  version: 1,
  generatedAt: Date.now(),
  model: 'Incremental vocabulary completion source',
  entries: selected,
};
writePrivateJson(outputArg, output);
process.stdout.write(`${JSON.stringify({
  eligible: candidates.length,
  advancedEligible: candidates.filter(candidate => candidate.needsAdvancedEnrichment).length,
  selected: selected.length,
  ignoredOlderNonCritical,
  missingHeadword,
  unauditedPhrases,
  deferred,
  providerFilter: providerFilter || null,
  recentSince,
})}\n`);
