import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exampleSetIssues,
  missingCardFields,
  USAGE_STATUSES,
  validUsageAudit,
} from '../../scripts/offline/vocab-card-contract.mjs';
import { vocabValidationIssues } from '../../server/src/ai-response.ts';
import { exampleSetIssues as serverExampleSetIssues } from '../../server/src/example-rules.ts';

// The cycle selects, completes and checks vocabulary cards by vocab-card-contract.mjs, and production's content audit
// judges the same stored cards by the server's validation. While the two disagreed, a card the cycle had finished
// stayed a gap to production, and its stall alert never cleared, so every case below goes through both.

const audit = { status: 'current_general', reason: 'This is current general English.', confidence: 'high', auditedAt: 1 };
const first = 'She brought a {{sample}} home before choosing the paint color.';
const second = 'The lab tested a {{sample}} from each shipment.';

const card = (overrides: Record<string, unknown> = {}) => ({
  id: 'sample',
  word: 'sample',
  sense: 'noun: an illustrative instance',
  chinese: '例子',
  ipa: '/ˈsæmpəl/',
  definition: 'One item used to illustrate a larger group or idea.',
  forms: ['sample', 'samples'],
  wordFamily: [{ word: 'sampling', pos: 'noun', chinese: '抽样' }],
  history: 'From Old French essample, ultimately from Latin exemplum.',
  register: 'Common in present-day American English.',
  mnemonic: 'A sample lets you see a small part of the whole.',
  imagePrompt: 'A photorealistic close view of one sample jar selected from a larger organized collection.',
  synonyms: ['example'],
  antonyms: [],
  confusables: [],
  examples: [first, second],
  usageAudit: audit,
  ...overrides,
});

// The card field each of the server's issues is about.
const issueField = (issue: string): string => /example/.test(issue) ? 'examples' : /"(\w+)"/.exec(issue)?.[1] ?? issue;
const serverFields = (value: unknown): string[] => [...new Set(vocabValidationIssues(value).map(issueField))];

const cases: Array<[string, Record<string, unknown>, string[]]> = [
  ['a valid card', {}, []],
  ['five lookups', { examples: ['The [[old]] [[town]] [[lab]] [[kept]] [[one]] {{sample}} of each batch.', second] }, ['examples']],
  ['an empty lookup', { examples: ['She brought a {{sample}} home [[ ]] before choosing the paint.', second] }, ['examples']],
  ['a stray bracket', { examples: ['She brought a {{sample}} home [before choosing the paint.', second] }, ['examples']],
  ['examples that differ only in case', { examples: [first, first.replace('She', 'she').replace('{{sample}}', '{{Sample}}')] }, ['examples']],
  ['examples that differ only in markup', { examples: [second, second.replace('lab', '[[lab]]')] }, ['examples']],
  ['a nested lookup', { examples: ['The lab tested a {{sample}} from [[each [[new]] shipment]].', first] }, ['examples']],
  ['a blank target', { examples: ['She brought a {{ }} home before choosing the paint.', second] }, ['examples']],
  ['three examples', { examples: [first, second, 'A third {{sample}} sentence, one too many.'] }, ['examples']],
  ['a newline in the IPA', { ipa: '/ˈsæm\npəl/' }, ['ipa']],
  ['a blank usage reason', { usageAudit: { ...audit, reason: '   ' } }, ['usageAudit']],
  ['a 1001-character usage reason', { usageAudit: { ...audit, reason: 'x'.repeat(1_001) } }, ['usageAudit']],
  ['an audit time given as text', { usageAudit: { ...audit, auditedAt: '5' } }, ['usageAudit']],
];

test('the cycle and the server judge a stored card\'s examples, usage audit and IPA alike', () => {
  for (const [label, overrides, fields] of cases) {
    assert.deepEqual(missingCardFields(card(overrides)), fields, `the cycle, ${label}`);
    assert.deepEqual(serverFields(card(overrides)), fields, `the server, ${label}`);
  }
});

test('a completion\'s usage audit meets the same rules before the stage stamps its time', () => {
  const { auditedAt: _auditedAt, ...answered } = audit;
  assert.equal(validUsageAudit(answered, { requireAuditedAt: false }), true);
  assert.equal(validUsageAudit(answered), false);
  assert.equal(validUsageAudit({ ...answered, reason: 'x'.repeat(1_001) }, { requireAuditedAt: false }), false);
  assert.equal(validUsageAudit({ ...answered, originalText: '' }, { requireAuditedAt: false }), false);
  for (const value of [null, 'current_general', [answered]]) {
    assert.equal(validUsageAudit(value, { requireAuditedAt: false }), false, JSON.stringify(value));
  }
  assert.deepEqual(missingCardFields(card({ usageAudit: answered }), { requireAuditedAt: false }), []);
});

test('the contract hands on the server\'s usage statuses, in the order every batch fingerprint repeats, and its example reasons', () => {
  assert.deepEqual([...USAGE_STATUSES], ['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized']);
  assert.equal(exampleSetIssues, serverExampleSetIssues);
});
