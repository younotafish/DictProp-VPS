// How current and useful a sense is in American English, as the corpus audit judges it, and what that means for
// archiving. Import-free, so the server, the client and the offline scripts can all load it.

export const USAGE_STATUSES = [
  'modern_american',
  'current_general',
  'british_only',
  'rare_or_dated',
  'narrow_specialized',
] as const;

export type UsageStatus = typeof USAGE_STATUSES[number];

/** The order senses are listed and recommended in: the most useful American usage first. */
export const USAGE_PRIORITY: Readonly<Record<UsageStatus, number>> = {
  modern_american: 0,
  current_general: 1,
  narrow_specialized: 2,
  british_only: 3,
  rare_or_dated: 4,
};

export interface UsageAudit {
  status: UsageStatus;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  auditedAt: number;
  originalText?: string;
}

export function isUsageAudit(value: unknown): value is UsageAudit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const audit = value as Record<string, unknown>;
  return typeof audit.status === 'string' && (USAGE_STATUSES as readonly string[]).includes(audit.status) &&
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
