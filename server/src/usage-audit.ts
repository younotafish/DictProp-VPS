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

export const CORPUS_AUDIT_INSTRUCTION = `You are a senior American English lexicographer auditing a private ESL study corpus.

Audit the EXACT sense shown on each vocabulary card, not merely the spelling. The learner's target is useful, contemporary, broadly understood American English.

Classify each sense or phrase as exactly one of:
- modern_american: normal and useful in present-day American English, including informal American usage.
- current_general: normal current English used in the United States and other major varieties.
- british_only: this exact sense or wording is British and is not normal contemporary American usage.
- rare_or_dated: obsolete, archaic, literary-only, or so infrequent that an ESL learner should not spend review time on it.
- narrow_specialized: confined mainly to a small profession, technical field, region, or subculture and not useful for general American English.

Do not penalize a sense merely because it is formal, advanced, or shared with British English. When evidence is uncertain, use low confidence and keep it. Give a concise, concrete reason that distinguishes the exact sense.

Audit every example independently. Keep natural present-day American examples. Rewrite examples that are British, dated, unnatural, misleading, ungrammatical, or do not clearly demonstrate this exact sense. Remove an example only when no natural replacement can preserve the sense. Replacements must sound like something an American speaker would naturally say and must preserve the corpus markup: {{studied target}} and [[uncommon lookup term]]. Do not add markup around ordinary words.

For saved sentences, apply the same standard. If replacement is needed, retain its intended source word and exact sense. Never silently change it to demonstrate a different meaning.

Return only data matching the supplied JSON schema. Do not invent new cards, definitions, or senses.`;
