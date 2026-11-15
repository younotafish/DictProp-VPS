import { corpusAuditImportState, validateCorpusAuditBundle, type CorpusAuditBundle } from '../corpus-audit.js';
import { getAllItems, upsertMany } from '../db.js';
import { backupBeforeWrite, recordStale } from '../import-support.js';
import { isSentenceAnalysis } from '../sentence-analysis.js';
import { validateStoredItem } from '../validation.js';
import { errorMessage, readBundleManifest } from './support/bundle.js';
import { finishImport, requireOwner } from './support/run.js';
import { finiteNonNegative, nextUpdatedAt, normalizedSrs } from './support/stored-item.js';

const { bundle } = readBundleManifest<CorpusAuditBundle>(
  'Usage: import-corpus-audit <manifest.json>',
  validateCorpusAuditBundle,
);
const owner = requireOwner();

const backup = await backupBeforeWrite('corpus-audit');
const result = {
  total: bundle.entries.length,
  updated: 0,
  alreadyApplied: 0,
  archivedForUsage: 0,
  archivedOnRequest: 0,
  unarchivedAfterCorrection: 0,
  stale: 0,
  staleIds: [] as string[],
  skipped: 0,
  errors: [] as Array<{ id: string; error: string }>,
};
const pending: any[] = [];
const archivedForUsageById = new Set<string>();
const archivedOnRequestById = new Set<string>();
const unarchivedById = new Set<string>();
const currentById = new Map(getAllItems(owner.id).map(item => [item.data.id, item]));
for (const entry of bundle.entries) {
  try {
    const current = currentById.get(entry.id) as any;
    // An item deleted or edited since the export is skipped without failing the run; the next export has it.
    if (!current || current.isDeleted) {
      recordStale(result, entry.id);
      continue;
    }
    if (current.type !== entry.type) throw new Error('item type changed after export');
    const { dataState, nextArchived, alreadyApplied } = corpusAuditImportState(
      current.data,
      current.isArchived === true,
      entry,
    );
    if (alreadyApplied) {
      result.alreadyApplied++;
      continue;
    }
    if (dataState === 'changed') {
      recordStale(result, entry.id);
      continue;
    }
    if (entry.data.usageAudit === undefined && current.data.usageAudit !== undefined) {
      throw new Error('entry would drop the item\'s usage audit');
    }

    const currentSrs = current.srs && typeof current.srs === 'object' ? current.srs : {};
    const preservedSentenceAnalysis = entry.type === 'sentence' && isSentenceAnalysis(current.data.analysis)
      ? {
          analysis: current.data.analysis,
          ...(finiteNonNegative(current.data.analysisGeneratedAt, 0) > 0
            ? { analysisGeneratedAt: current.data.analysisGeneratedAt }
            : {}),
        }
      : {};
    const preservedSentenceSpeechStyle = entry.type === 'sentence' &&
      (current.data.preferredSpeechStyle === 'clear' || current.data.preferredSpeechStyle === 'casual')
      ? { preferredSpeechStyle: current.data.preferredSpeechStyle }
      : {};
    // current is the entry's own item (looked up by its id, its type checked above), so its identity is the entry's.
    const candidate = {
      ...current,
      data: { ...entry.data, ...preservedSentenceAnalysis, ...preservedSentenceSpeechStyle },
      srs: normalizedSrs(current, currentSrs),
      savedAt: finiteNonNegative(current.savedAt, Date.now()),
      isArchived: nextArchived,
      updatedAt: nextUpdatedAt(current.updatedAt),
    };
    const itemError = validateStoredItem(candidate);
    if (itemError) throw new Error(itemError);
    pending.push(candidate);
    if (!current.isArchived && nextArchived) {
      (entry.archiveForUsage ? archivedForUsageById : archivedOnRequestById).add(entry.id);
    }
    if (current.isArchived && !nextArchived) unarchivedById.add(entry.id);
  } catch (error) {
    result.skipped++;
    result.errors.push({ id: entry.id, error: errorMessage(error) });
  }
}

const recordWrite = (candidate: any, conflicts: Set<string>) => {
  const id = candidate.data.id;
  if (conflicts.has(id)) {
    recordStale(result, id);
    return;
  }
  result.updated++;
  if (archivedForUsageById.has(id)) result.archivedForUsage++;
  if (archivedOnRequestById.has(id)) result.archivedOnRequest++;
  if (unarchivedById.has(id)) result.unarchivedAfterCorrection++;
};

// The audited data is the whole item: it must match the audited hash exactly, so a server-owned field
// it leaves out is removed rather than carried over from the stored row.
const writeOptions = { replaceServerFields: true };
for (let index = 0; index < pending.length; index += 500) {
  const batch = pending.slice(index, index + 500);
  try {
    const write = upsertMany(batch, owner.id, writeOptions);
    const conflicts = new Set(write.conflicts);
    for (const candidate of batch) recordWrite(candidate, conflicts);
  } catch (batchError) {
    // Isolate a bad legacy record instead of losing every valid item in its transaction batch.
    for (const candidate of batch) {
      try {
        const write = upsertMany([candidate], owner.id, writeOptions);
        recordWrite(candidate, new Set(write.conflicts));
      } catch (error) {
        result.skipped++;
        result.errors.push({ id: candidate.data.id, error: errorMessage(error || batchError) });
      }
    }
  }
}

finishImport(result, backup);
