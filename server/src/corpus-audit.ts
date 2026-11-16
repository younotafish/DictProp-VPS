import { corpusSourceHash } from './corpus-hash.js';
import { isUsageAudit, resolveUsageArchive, shouldArchiveUsage } from './shared/usage-audit.js';
import { isItemType, isPositiveFinite, isRecord, isSha256, type ItemType } from './validation-helpers.js';

// The hash lives in corpus-hash.ts, which the offline scripts load under plain node; the exporter and the importers
// keep reaching it here.
export { corpusSourceHash };

export type CorpusItemType = ItemType;

export interface CorpusExportRecord {
  id: string;
  type: CorpusItemType;
  sourceHash: string;
  wasArchived: boolean;
  savedAt: number;
  data: Record<string, unknown>;
}

export interface CorpusAuditEntry {
  id: string;
  type: CorpusItemType;
  sourceHash: string;
  data: Record<string, unknown>;
  wasArchived: boolean;
  archiveForUsage: boolean;
  /** Overrides the archive state the usage audit implies: archives a duplicate, or keeps a restored card live. */
  setArchived?: boolean;
}

export interface CorpusAuditBundle {
  version: 1;
  generatedAt: number;
  model: string;
  entries: CorpusAuditEntry[];
}

export function corpusAuditDataState(
  currentData: unknown,
  entry: Pick<CorpusAuditEntry, 'sourceHash' | 'data'>,
): 'source' | 'target' | 'changed' {
  const currentHash = corpusSourceHash(currentData);
  if (currentHash === corpusSourceHash(entry.data)) return 'target';
  if (currentHash === entry.sourceHash) return 'source';
  return 'changed';
}

export function corpusAuditImportState(
  currentData: unknown,
  currentArchived: boolean,
  entry: Pick<CorpusAuditEntry, 'sourceHash' | 'data' | 'setArchived'>,
): {
  dataState: 'source' | 'target' | 'changed';
  nextArchived: boolean;
  alreadyApplied: boolean;
} {
  const dataState = corpusAuditDataState(currentData, entry);
  const currentAudit = isRecord(currentData) ? currentData.usageAudit : undefined;
  const nextAudit = isRecord(entry.data) ? entry.data.usageAudit : undefined;
  const nextArchived = typeof entry.setArchived === 'boolean'
    ? entry.setArchived
    : resolveUsageArchive(currentArchived, currentAudit, nextAudit);
  return {
    dataState,
    nextArchived,
    alreadyApplied: dataState === 'target' && currentArchived === nextArchived,
  };
}

function hasCompleteAudit(type: CorpusItemType, data: Record<string, unknown>): boolean {
  // Saved sentences were not all audited; the importer refuses an entry that drops an existing audit.
  if (type === 'sentence' && data.usageAudit === undefined) return true;
  if (!isUsageAudit(data.usageAudit)) return false;
  if (type !== 'phrase') return true;
  return Array.isArray(data.vocabs) && data.vocabs.every((vocab: unknown) =>
    isRecord(vocab) && isUsageAudit(vocab.usageAudit));
}

export function validateCorpusAuditBundle(value: unknown): string | null {
  if (!isRecord(value)) return 'bundle must be an object';
  if (value.version !== 1) return 'unsupported bundle version';
  if (!isPositiveFinite(value.generatedAt)) return 'bundle generatedAt is invalid';
  if (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 200) {
    return 'bundle model is invalid';
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 20_000) {
    return 'bundle entries must contain 1 to 20000 records';
  }
  const ids = new Set<string>();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index];
    if (!isRecord(entry)) return `entry ${index} must be an object`;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 200) {
      return `entry ${index} id is invalid`;
    }
    if (ids.has(entry.id)) return `entry ${index} duplicates id ${entry.id}`;
    ids.add(entry.id);
    if (!isItemType(entry.type)) return `entry ${index} type is invalid`;
    if (!isSha256(entry.sourceHash)) return `entry ${index} sourceHash is invalid`;
    if (!isRecord(entry.data) || entry.data.id !== entry.id) return `entry ${index} data identity is invalid`;
    if (typeof entry.wasArchived !== 'boolean') return `entry ${index} wasArchived is invalid`;
    if (!hasCompleteAudit(entry.type, entry.data)) {
      return `entry ${index} does not contain a complete usage audit`;
    }
    if (typeof entry.archiveForUsage !== 'boolean') return `entry ${index} archiveForUsage is invalid`;
    // A complete audit is a valid one, or a saved sentence's missing one.
    const audit = entry.data.usageAudit;
    const expectedArchive = isUsageAudit(audit) && shouldArchiveUsage(audit.status, audit.confidence);
    if (entry.archiveForUsage !== expectedArchive) return `entry ${index} archiveForUsage disagrees with usage audit`;
    if (entry.setArchived !== undefined && typeof entry.setArchived !== 'boolean') return `entry ${index} setArchived is invalid`;
  }
  return null;
}
