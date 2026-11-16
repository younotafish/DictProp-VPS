// One definition of a complete vocabulary card, shared by the incremental selector and the completion
// stage. When they disagreed, a card the completion stage accepted was selected again on every cycle.
// Its usage-audit and example rules are the server's own, so a card the cycle completes is one production's
// content audit accepts, and one it rejects is selected again.

import { exampleSetIssues, isValidGeneratedExampleSet } from '../../server/src/example-rules.ts';
import { isUsageAudit, USAGE_STATUSES } from '../../server/src/shared/usage-audit.ts';

// The server's list, in its order, which complete-corpus-fields.mjs's schema, and so every batch fingerprint, repeats.
export { USAGE_STATUSES };
// Why a set of examples fails, one reason per problem, in words the model can act on.
export { exampleSetIssues };

export function validString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Model output has no auditedAt yet; the completion stage stamps it when the audit is applied.
export function validUsageAudit(value, { requireAuditedAt = true } = {}) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    isUsageAudit(requireAuditedAt ? value : { ...value, auditedAt: 1 });
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
  if (!isValidGeneratedExampleSet(card?.examples)) missing.push('examples');
  if (!validUsageAudit(card?.usageAudit, { requireAuditedAt })) missing.push('usageAudit');
  return [...new Set(missing)];
}
