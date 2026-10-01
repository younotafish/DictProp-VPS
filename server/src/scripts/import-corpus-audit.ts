import { readFileSync } from 'fs';
import { resolve } from 'path';
import { corpusAuditImportState, validateCorpusAuditBundle, type CorpusAuditBundle } from '../corpus-audit.js';
import { getAllItems, listAllUsers, upsertMany } from '../db.js';
import { env } from '../env.js';
import { backupBeforeWrite, checkpointAfterWrite, recordStale } from '../import-support.js';
import { isOwnerUser } from '../owner-access.js';
import { isSentenceAnalysis } from '../sentence-analysis.js';
import { validateStoredItem } from '../validation.js';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: import-corpus-audit <manifest.json>');

const bundle = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as CorpusAuditBundle;
const validationError = validateCorpusAuditBundle(bundle);
if (validationError) throw new Error(validationError);

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

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
const finiteNonNegative = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
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

    const { project: _legacyProject, ...currentWithoutProject } = current;
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
    const candidate = {
      ...currentWithoutProject,
      data: { ...entry.data, ...preservedSentenceAnalysis, ...preservedSentenceSpeechStyle },
      srs: {
        ...currentSrs,
        id: entry.id,
        type: entry.type,
        nextReview: finiteNonNegative(currentSrs.nextReview, 0),
        interval: finiteNonNegative(currentSrs.interval, 0),
        memoryStrength: finiteNonNegative(currentSrs.memoryStrength, 0),
        lastReviewDate: finiteNonNegative(currentSrs.lastReviewDate, 0),
        totalReviews: finiteNonNegative(currentSrs.totalReviews, 0),
        correctStreak: finiteNonNegative(currentSrs.correctStreak, 0),
        stability: finiteNonNegative(currentSrs.stability, 0),
      },
      savedAt: finiteNonNegative(current.savedAt, Date.now()),
      isArchived: nextArchived,
      updatedAt: Math.max(Date.now(), Number(current.updatedAt || 0) + 1),
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
    result.errors.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
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
        result.errors.push({
          id: candidate.data.id,
          error: error instanceof Error ? error.message : String(error || batchError),
        });
      }
    }
  }
}

checkpointAfterWrite();
process.stdout.write(`${JSON.stringify({ ...result, backup })}\n`);
if (result.errors.length > 0) process.exitCode = 1;
