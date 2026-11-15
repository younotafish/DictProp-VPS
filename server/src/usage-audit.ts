export const USAGE_STATUSES = [
  'modern_american',
  'current_general',
  'british_only',
  'rare_or_dated',
  'narrow_specialized',
] as const;

export type UsageStatus = typeof USAGE_STATUSES[number];

export interface UsageAudit {
  status: UsageStatus;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  auditedAt: number;
  originalText?: string;
}

const STATUS_SET = new Set<string>(USAGE_STATUSES);

export function isUsageAudit(value: unknown): value is UsageAudit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const audit = value as Record<string, unknown>;
  return typeof audit.status === 'string' && STATUS_SET.has(audit.status) &&
    typeof audit.reason === 'string' && audit.reason.trim().length > 0 && audit.reason.length <= 1_000 &&
    (audit.confidence === 'high' || audit.confidence === 'medium' || audit.confidence === 'low') &&
    typeof audit.auditedAt === 'number' && Number.isFinite(audit.auditedAt) && audit.auditedAt > 0 &&
    (audit.originalText === undefined ||
      (typeof audit.originalText === 'string' && audit.originalText.length > 0 && audit.originalText.length <= 10_000));
}

export function shouldArchiveUsage(status: UsageStatus, confidence: UsageAudit['confidence']): boolean {
  if (confidence === 'low') return false;
  return status === 'british_only' || status === 'rare_or_dated' || status === 'narrow_specialized';
}

/**
 * Keep explicit/manual archives, but let a later verified audit reverse an archive that the previous
 * usage classification itself caused. The current audit is the only durable provenance available for
 * legacy bulk archives, so a common/current audit on an archived item is treated as user-owned.
 */
export function resolveUsageArchive(
  currentArchived: boolean,
  currentAudit: unknown,
  nextAudit: unknown,
): boolean {
  if (!isUsageAudit(nextAudit)) return currentArchived;
  if (shouldArchiveUsage(nextAudit.status, nextAudit.confidence)) return true;
  const wasArchivedForUsage = currentArchived && isUsageAudit(currentAudit) &&
    shouldArchiveUsage(currentAudit.status, currentAudit.confidence);
  return currentArchived && !wasArchivedForUsage;
}
