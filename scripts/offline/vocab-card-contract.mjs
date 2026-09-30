// One definition of a complete vocabulary card, shared by the incremental selector and the completion
// stage. When they disagreed, a card the completion stage accepted was selected again on every cycle.

export const USAGE_STATUSES = ['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized'];
export const USAGE_CONFIDENCES = ['high', 'medium', 'low'];

export function validString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Model output has no auditedAt yet; the completion stage stamps it when the audit is applied.
export function validUsageAudit(value, { requireAuditedAt = true } = {}) {
  return Boolean(value) && typeof value === 'object' &&
    USAGE_STATUSES.includes(value.status) && validString(value.reason) &&
    USAGE_CONFIDENCES.includes(value.confidence) &&
    (!requireAuditedAt || Number(value.auditedAt) > 0);
}

export function validExample(value) {
  return validString(value) && value.trim().length >= 20 &&
    value.length <= 1_000 && (value.match(/\{\{([^{}]+)\}\}/g) || []).length === 1;
}

// The headword is the card's identity and is never written by the completion stage, so it is checked
// separately by the selector rather than reported as a fillable field.
export function missingCardFields(card, { requireAuditedAt = true } = {}) {
  const missing = [];
  for (const [field, minimum] of [
    ['sense', 3], ['chinese', 1], ['definition', 10], ['history', 20],
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
  if (!validUsageAudit(card?.usageAudit, { requireAuditedAt })) missing.push('usageAudit');
  return [...new Set(missing)];
}
