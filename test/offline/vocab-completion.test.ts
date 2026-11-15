import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasCurrentLocalAdvancedEnrichment,
  markLocalAdvancedEnrichment,
} from '../../scripts/offline/local-advanced-enrichment.mjs';
import {
  applyCompletions,
  collectCompletionTasks,
  compactTask,
  corpusHash,
  fillCard,
  normalizeCompletion,
  readCompletionResults,
  validateCompletion,
} from '../../scripts/offline/vocab-completion.mjs';
import { sha256 } from '../support/fs.ts';

const card = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  word: id,
  sense: 'noun: an illustrative instance',
  chinese: '例子',
  ipa: '/ˈsæmpəl/',
  definition: 'One item used to illustrate a larger group or idea.',
  forms: ['sample', 'samples'],
  wordFamily: [],
  history: 'From Old French essample, ultimately from Latin exemplum.',
  register: 'Common in present-day American English.',
  mnemonic: 'A sample lets you see a small part of the whole.',
  imagePrompt: 'A photorealistic close view of one sample jar selected from a larger organized collection.',
  synonyms: ['example'],
  antonyms: [],
  confusables: [],
  examples: [
    `She brought a {{${id}}} home before choosing the paint color.`,
    `The lab tested a {{${id}}} from each shipment.`,
  ],
  usageAudit: { status: 'current_general', reason: 'This is current general English.', confidence: 'high', auditedAt: 1 },
  ...overrides,
});
const enriched = (id: string, overrides: Record<string, unknown> = {}) =>
  markLocalAdvancedEnrichment(card(id, overrides), 'earlier-model', 1, 'claude-code');

// What the model returns for one card.
const completion = (overrides: Record<string, unknown> = {}) => ({
  sense: '  noun: a fresh sense  ',
  chinese: '新的例子',
  ipa: '/ˈsæmpəl/',
  definition: 'A newly written definition for this exact sense.',
  forms: ['sample'],
  wordFamily: [{ word: 'sampling', pos: 'noun', chinese: '抽样' }],
  synonyms: ['specimen'],
  antonyms: [],
  confusables: ['simple'],
  examples: ['I tested a {{sample}} before ordering.', 'The lab kept a {{sample}} from every shipment.'],
  history: 'Through Old French from Latin exemplum, an example.',
  register: 'Common in everyday American English.',
  mnemonic: 'A sample is a small part of the whole.',
  imagePrompt: 'A realistic photograph of one sample jar beside a larger collection in natural light.',
  usageAudit: { status: 'rare_or_dated', reason: 'Mostly heard in older usage.', confidence: 'medium' },
  ...overrides,
});

test('cards that miss a field or a current local enrichment become tasks; finished cards do not', () => {
  const tasks = collectCompletionTasks([
    { id: 'stale', type: 'vocab', data: card('stale') },
    { id: 'gap', type: 'vocab', data: enriched('gap', { chinese: 'example' }) },
    { id: 'done', type: 'vocab', data: enriched('done') },
    { id: 'phrase', type: 'phrase', data: { query: 'a phrase', vocabs: [enriched('kept'), card('first-word', { id: '' })] } },
    { id: 'sentence', type: 'sentence', data: { text: 'Not a card.' } },
  ]);
  assert.deepEqual(tasks.map(task => [task.parentId, task.cardIndex, task.cardId, task.missing, task.refreshAll]), [
    ['stale', 0, 'stale', [], true],
    // A card whose marker still matches it is only repaired.
    ['gap', 0, 'gap', ['chinese'], false],
    ['phrase', 1, 'phrase', [], true],
  ]);
  assert.equal(tasks[2].parentQuery, 'a phrase');
  assert.equal(tasks[0].parentQuery, undefined);
});

test('the record sent for a card names its mode and carries the card fields in a fixed order', () => {
  const [task] = collectCompletionTasks([{ id: 'stale', type: 'vocab', data: card('stale') }]);
  const record = compactTask(task, 3);
  assert.deepEqual(Object.keys(record), [
    'itemIndex', 'parentType', 'parentQuery', 'missingFields', 'mode', 'word', 'sense', 'chinese', 'ipa', 'definition',
    'forms', 'wordFamily', 'synonyms', 'antonyms', 'confusables', 'examples', 'history', 'register', 'mnemonic',
    'imagePrompt', 'usageAudit',
  ]);
  assert.equal(record.itemIndex, 3);
  assert.equal(record.mode, 'advanced_rewrite');
  assert.equal(compactTask({ ...task, refreshAll: false }, 0).mode, 'repair_missing_fields');
});

test('a completion is checked against the card contract and reports each problem', () => {
  const [task] = collectCompletionTasks([{ id: 'stale', type: 'vocab', data: card('stale') }]);
  assert.doesNotThrow(() => validateCompletion(completion(), task));
  assert.throws(() => validateCompletion(null, task), /^Error: stale: result is not an object$/);
  assert.throws(() => validateCompletion(completion({ chinese: 'sample', ipa: 'ˈsæmpəl' }), task),
    /^Error: stale: chinese must be a Simplified Chinese equivalent; IPA must be one General American transcription/);
  assert.throws(() => validateCompletion(completion({ history: 'Short.' }), task), /stale: history is missing or too short/);
  assert.throws(() => validateCompletion(completion({ synonyms: [] }), task), /^Error: stale: synonyms are empty$/);
});

test('alternative pronunciations in separate slash pairs become one transcription', () => {
  assert.equal(normalizeCompletion(completion({ ipa: '/ˈtoʊmeɪtoʊ/ (or) /təˈmɑtoʊ/' })).ipa, '/ˈtoʊmeɪtoʊ/ (or) /təˈmɑtoʊ/');
  assert.equal(normalizeCompletion(completion({ ipa: ' /ˈtoʊmeɪtoʊ/; /təˈmɑtoʊ/ ' })).ipa, '/ˈtoʊmeɪtoʊ; təˈmɑtoʊ/');
  assert.equal(normalizeCompletion(completion({ ipa: '/ə/ – /eɪ/' })).ipa, '/ə; eɪ/');
  const single = completion();
  assert.equal(normalizeCompletion(single), single);
  assert.equal(normalizeCompletion(undefined), undefined);
});

test('a batch answer is read by item index, normalized and checked', () => {
  const tasks = collectCompletionTasks([
    { id: 'one', type: 'vocab', data: card('one') },
    { id: 'two', type: 'vocab', data: card('two') },
  ]);
  const results = readCompletionResults({
    results: [{ itemIndex: 1, ...completion() }, { itemIndex: 0, ...completion({ ipa: '/a/ /b/' }) }],
  }, tasks);
  assert.deepEqual(results.map(({ task }: { task: { cardId: string } }) => task.cardId), ['one', 'two']);
  assert.equal(results[0].completion.ipa, '/a; b/');
  assert.throws(() => readCompletionResults({ results: [] }, tasks), /^Error: Model returned the wrong result count$/);
  assert.throws(() => readCompletionResults({ results: [{ itemIndex: 0 }, { itemIndex: 0 }] }, tasks),
    /^Error: Model returned duplicate item indexes$/);
  assert.throws(() => readCompletionResults({ results: [{ itemIndex: 0, ...completion() }, { itemIndex: 5 }] }, tasks),
    /^Error: Model omitted item index 1$/);
});

test('a rewrite replaces every learning field, and a repair only the missing ones', () => {
  const marker = { model: 'claude-opus-5-5', provider: 'claude-code', generatedAt: 5_000 };
  const rewritten = fillCard(card('stale'), completion(), marker);
  assert.equal(rewritten.sense, 'noun: a fresh sense');
  assert.equal(rewritten.chinese, '新的例子');
  assert.deepEqual(rewritten.synonyms, ['specimen']);
  assert.deepEqual(rewritten.usageAudit, { ...completion().usageAudit, auditedAt: 5_000 });
  assert.equal(rewritten.advancedEnrichment.provider, 'claude-code');
  assert.equal(rewritten.advancedEnrichment.model, 'claude-opus-5-5');
  assert.equal(rewritten.advancedEnrichment.generatedAt, 5_000);
  assert.equal(hasCurrentLocalAdvancedEnrichment(rewritten), true);

  // An enriched card whose marker still matches keeps everything but the field it misses.
  const current = markLocalAdvancedEnrichment(card('gap', { register: 'Short.' }), 'earlier-model', 1, 'claude-code');
  const repaired = fillCard(current, completion(), marker);
  assert.equal(repaired.register, 'Common in everyday American English.');
  assert.equal(repaired.chinese, '例子');
  assert.equal(repaired.usageAudit.auditedAt, 1);

  assert.throws(() => fillCard(card('stale'), completion({ examples: ['Too short {{x}}.'] }), marker),
    /^Error: stale: still missing examples after completion$/);
});

test('completed cards are merged into their parents, and a failed card holds back only its own item', () => {
  const entries = [
    { id: 'alpha', type: 'vocab', sourceHash: 'old-alpha', data: card('alpha', { imageUrl: 'server:has_image:v1' }) },
    { id: 'poison', type: 'vocab', data: card('poison') },
    { id: 'broken', type: 'vocab', data: card('broken') },
    { id: 'phrase', type: 'phrase', data: { query: 'q', vocabs: [enriched('kept'), card('word')] } },
    { id: 'untouched', type: 'vocab', data: enriched('untouched') },
  ];
  const tasks = collectCompletionTasks(entries);
  const byParent = (id: string) => tasks.filter(task => task.parentId === id);
  const completed = [
    { task: byParent('alpha')[0], completion: completion() },
    { task: byParent('broken')[0], completion: completion({ chinese: 7 }) },
    { task: byParent('phrase')[0], completion: completion({ usageAudit: { status: 'british_only', reason: 'UK.', confidence: 'high' } }) },
  ];
  const failures = [{ task: byParent('poison')[0], error: 'model failed' }];
  const result = applyCompletions(entries, completed, failures, { model: 'm', provider: 'claude-code', generatedAt: 9 });

  assert.deepEqual(result.entries.map(entry => entry.id), ['alpha', 'phrase', 'untouched']);
  assert.equal(result.completedCards, 2);
  assert.deepEqual([...result.failedParents], [['poison', 'poison: model failed'], ['broken', result.checkFailures[0].message]]);
  assert.deepEqual(result.checkFailures.map(failure => failure.id), ['broken']);

  const [alpha, phrase, untouched] = result.entries;
  // The source hash is the item before this pass, without its image fields.
  assert.equal(alpha.sourceHash, corpusHash(entries[0].data));
  assert.equal(corpusHash(entries[0].data), sha256(JSON.stringify(card('alpha'))));
  assert.equal(alpha.archiveForUsage, true);
  assert.equal(alpha.data.imageUrl, 'server:has_image:v1');
  assert.equal(phrase.archiveForUsage, undefined);
  assert.equal(phrase.data.vocabs[0], entries[3].data.vocabs[0]);
  assert.equal(phrase.data.vocabs[1].usageAudit.status, 'british_only');
  assert.equal(untouched.data, entries[4].data);
  assert.equal(untouched.archiveForUsage, false);
});
