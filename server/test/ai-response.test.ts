import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exampleIssues,
  exampleSetIssues,
  hasCompleteGeneratedVocabMetadata,
  isValidGeneratedExample,
  isValidGeneratedExampleSet,
  normalizeAnalysisResponse,
  normalizeVocabCard,
  repairGeneratedExample,
  repairIpa,
  REGISTER_MINIMUM,
  sortVocabsByUsage,
  vocabValidationIssues,
} from '../src/ai-response.js';
import { isUsageAudit, type UsageStatus } from '../src/shared/usage-audit.js';

const completeCard = (overrides: Record<string, unknown> = {}) => ({
  word: 'bank',
  sense: 'noun: finance',
  chinese: '银行',
  ipa: '/bæŋk/',
  definition: 'A financial institution.',
  forms: ['bank', 'banks'],
  wordFamily: [],
  synonyms: ['financial institution'],
  antonyms: [],
  confusables: [],
  examples: [
    'I stopped by the {{bank}} after work to deposit my paycheck.',
    'The {{bank}} approved our mortgage sooner than I expected.',
  ],
  history: 'From Old Norse banki, later applied to a financial counter and institution.',
  register: 'Common, current general English.',
  mnemonic: 'Picture money stored safely inside a bank vault.',
  imagePrompt: 'A realistic neighborhood bank counter with a customer depositing a paycheck, natural daylight, no visible text.',
  usageAudit: { status: 'current_general', reason: 'Normal in current American English.', confidence: 'high' },
  ...overrides,
});

test('normalization repairs optional model fields instead of rejecting the whole search', () => {
  const normalized = normalizeVocabCard(completeCard({
    forms: null,
    synonyms: 'lender',
    antonyms: undefined,
    confusables: [{ sentence: 'bank/bankroll' }],
    imagePrompt: null,
    usageAudit: undefined,
  }), 'bank', 1234);

  assert.ok(normalized);
  assert.deepEqual(normalized.forms, []);
  assert.deepEqual(normalized.synonyms, ['lender']);
  assert.deepEqual(normalized.antonyms, []);
  assert.deepEqual(normalized.confusables, ['bank/bankroll']);
  assert.equal(normalized.imagePrompt, '');
  assert.deepEqual(normalized.usageAudit, {
    status: 'current_general',
    reason: 'Automatically classified from the register note: Common, current general English.',
    confidence: 'low',
    auditedAt: 1234,
  });
});

test('normalization keeps usable siblings, drops unusable cards, and orders senses by learner value', () => {
  const result = normalizeAnalysisResponse({
    query: 'bank',
    vocabs: [
      completeCard({
        sense: 'obsolete meaning',
        usageAudit: { status: 'rare_or_dated', reason: 'Obsolete.', confidence: 'high' },
      }),
      { word: 'bank', chinese: '坏数据' },
      completeCard({
        sense: 'common meaning',
        usageAudit: { status: 'modern_american', reason: 'Common in the US.', confidence: 'high' },
      }),
      completeCard({
        sense: 'British meaning',
        usageAudit: { status: 'British only', reason: 'Use the US equivalent instead.', confidence: 'medium' },
      }),
    ],
  }, { fallbackQuery: 'bank', auditedAt: 5678 });

  assert.equal(result.inputCards, 4);
  assert.equal(result.droppedCards, 1);
  assert.deepEqual(result.data.vocabs.map(vocab => vocab.sense), [
    'common meaning',
    'British meaning',
    'obsolete meaning',
  ]);
  assert.ok(result.data.vocabs.every(vocab => isUsageAudit(vocab.usageAudit)));
  assert.ok(result.data.vocabs.every(vocab => vocab.usageAudit.auditedAt === 5678));
});

test('the card order follows the shared usage priority and puts senses without an audit last, each in its own order', () => {
  const sense = (id: string, status?: UsageStatus) => ({ id, ...(status ? { usageAudit: { status } } : {}) });
  const ordered = sortVocabsByUsage([
    sense('unaudited-first'),
    sense('rare', 'rare_or_dated'),
    sense('unaudited-second'),
    sense('british', 'british_only'),
    sense('specialized', 'narrow_specialized'),
    sense('general', 'current_general'),
    sense('modern', 'modern_american'),
  ]);
  assert.deepEqual(ordered.map(vocab => vocab.id), [
    'modern', 'general', 'specialized', 'british', 'rare', 'unaudited-first', 'unaudited-second',
  ]);
});

test('a card that comes back without its word is for the query in word mode and dropped in a sentence', () => {
  const sentence = 'We sat on the bank by the river all day.';
  const wordless = completeCard({ word: undefined, sense: 'noun: river' });
  const inSentence = normalizeAnalysisResponse({ query: sentence, translation: '我们在河边坐了一整天。', vocabs: [completeCard(), wordless] },
    { fallbackQuery: sentence, auditedAt: 1 });
  assert.deepEqual(inSentence.data.vocabs.map(vocab => vocab.word), ['bank']);
  assert.equal(inSentence.droppedCards, 1);

  const inWordMode = normalizeAnalysisResponse({ query: 'bank', vocabs: [wordless] }, { fallbackQuery: 'bank', queryIsHeadword: true, auditedAt: 1 });
  assert.deepEqual(inWordMode.data.vocabs.map(vocab => vocab.word), ['bank']);
  // The headword the model resolved (a Chinese query's English) names the card, not the input.
  const resolved = normalizeAnalysisResponse({ query: 'bank', vocabs: [wordless] }, { fallbackQuery: '银行', queryIsHeadword: true, auditedAt: 1 });
  assert.equal(resolved.data.vocabs[0].word, 'bank');
});

test('normalization accepts common model aliases for essential fields', () => {
  const result = normalizeAnalysisResponse({
    query: '',
    vocab: {
      term: 'wind down',
      meaning: 'To gradually relax or reduce activity.',
      translation: '逐渐放松；逐步结束',
      pronunciation: '/waɪnd daʊn/',
      usageExamples: 'I need an hour to {{wind down}} after work.',
      usage: { label: 'current general', explanation: 'Common in everyday speech.', confidence: 'high' },
    },
  }, { fallbackQuery: 'wind down', auditedAt: 999 });

  assert.equal(result.data.query, 'wind down');
  assert.equal(result.data.vocabs.length, 1);
  assert.equal(result.data.vocabs[0].word, 'wind down');
  assert.deepEqual(result.data.vocabs[0].examples, ['I need an hour to {{wind down}} after work.']);
  assert.equal(result.data.vocabs[0].usageAudit.status, 'current_general');
});

test('normalization keeps exactly two distinct examples when the model overproduces', () => {
  const normalized = normalizeVocabCard(completeCard({
    examples: [
      'I stopped by the {{bank}} after work to deposit my paycheck.',
      'I stopped by the {{bank}} after work to deposit my paycheck.',
      'The {{bank}} finally approved our [[small-business loan]] this morning.',
      'We called the {{bank}} to ask about the unexpected fee.',
    ],
  }), 'bank', 1234);

  assert.ok(normalized);
  assert.deepEqual(normalized.examples, [
    'I stopped by the {{bank}} after work to deposit my paycheck.',
    'The {{bank}} finally approved our [[small-business loan]] this morning.',
  ]);
  assert.equal(isValidGeneratedExampleSet(normalized.examples), true);
});

test('generated examples require distinct target markup and balanced uncommon-term markup', () => {
  assert.equal(isValidGeneratedExampleSet([
    'I stopped by the {{bank}} after work to deposit my paycheck.',
    'The {{bank}} approved our [[small-business loan]] this morning.',
  ]), true);
  assert.equal(isValidGeneratedExampleSet([
    'I stopped by the bank after work to deposit my paycheck.',
    'The {{bank}} approved our [[small-business loan] this morning.',
  ]), false);
  assert.equal(isValidGeneratedExampleSet([
    'I stopped by the {{bank}} after work to deposit my paycheck.',
    'I stopped by the {{bank}} after work to deposit my paycheck.',
  ]), false);
});

test('generated cards cannot pass with empty legacy metadata', () => {
  const complete = normalizeVocabCard(completeCard(), 'bank', 1234);
  assert.equal(hasCompleteGeneratedVocabMetadata(complete), true);
  assert.equal(hasCompleteGeneratedVocabMetadata({ ...complete, mnemonic: '' }), false);
  assert.equal(hasCompleteGeneratedVocabMetadata({
    ...complete,
    wordFamily: [{ word: 'banker', pos: '', chinese: '银行家' }],
  }), false);
});

test('pronunciations are reduced to the single /…/ transcription the validator wants', () => {
  assert.equal(repairIpa('/ˈbæŋk/', 'bank'), '/ˈbæŋk/');
  assert.equal(repairIpa('/rʌn/ /daʊn/', 'run down'), '/rʌn daʊn/');
  assert.equal(repairIpa('/təˈmeɪtoʊ/ or /təˈmɑtoʊ/', 'tomato'), '/təˈmeɪtoʊ/');
  assert.equal(repairIpa('US /bæŋk/, UK /baŋk/', 'bank'), '/bæŋk/');
  assert.equal(repairIpa('[bæŋk]', 'bank'), '/bæŋk/');
  assert.equal(repairIpa('ˈbæŋk', 'bank'), '/ˈbæŋk/');
  // Plain spelling is not a transcription; it stays unrepaired so validation still rejects it.
  assert.equal(repairIpa('bank', 'bank'), 'bank');
  assert.equal(repairIpa('', 'bank'), '');
});

test('a pronunciation broken over two lines fails validation, as it does in the offline contract', () => {
  const card = normalizeVocabCard(completeCard({ ipa: '/bæ\nŋk/' }), 'bank', 1234);
  assert.ok(card);
  assert.deepEqual(vocabValidationIssues(card), ['"ipa" must be exactly one American IPA transcription wrapped in slashes, like /ˈbæŋk/']);
  assert.deepEqual(vocabValidationIssues({ ...card, ipa: '/ˈbæŋk/' }), []);
});

test('example markup slips are repaired without changing the wording', () => {
  const cases: Array<[string, string, string[], string]> = [
    ['I had to {{[[bank]] on}} my friend for a ride home.', 'bank on', [], 'I had to {{bank on}} my friend for a ride home.'],
    ['She said [the {{bank}} closed early today.', 'bank', [], 'She said the {{bank}} closed early today.'],
    ['The {{river}} overflowed its {{bank}} after the storm.', 'bank', [], 'The [[river]] overflowed its {{bank}} after the storm.'],
    ['I stopped by the [[bank]] after work today.', 'bank', [], 'I stopped by the {{bank}} after work today.'],
    ['We banked on the weather holding for the picnic.', 'bank on', ['banks on', 'banked on'], 'We {{banked on}} the weather holding for the picnic.'],
    ['A [[a1]] [[b2]] [[c3]] [[d4]] [[e5]] {{bank}} sentence here.', 'bank', [], 'A [[a1]] [[b2]] [[c3]] [[d4]] e5 {{bank}} sentence here.'],
    ['I went to the {{}} [[ ]] {{bank}} to deposit cash today.', 'bank', [], 'I went to the {{bank}} to deposit cash today.'],
    // A fragment marked first never takes the target from the item itself.
    ['{{In}} the end, she {{indeed}} showed up on time.', 'indeed', [], '[[In]] the end, she {{indeed}} showed up on time.'],
    ['{{A}} friend of mine owes me {{a lot}} of money, honestly.', 'a lot', [], '[[A]] friend of mine owes me {{a lot}} of money, honestly.'],
    // A phrase split over two targets becomes one target, an object and all.
    ['She was totally {{run}} {{down}} after that trip.', 'run down', [], 'She was totally {{run down}} after that trip.'],
    ['He {{turned}} it {{down}} without a second thought.', 'turn down', ['turns down', 'turned down'], 'He {{turned it down}} without a second thought.'],
    ['I {{turned}} the offer {{down}} flat, honestly.', 'turn down', ['turned down'], 'I {{turned the offer down}} flat, honestly.'],
    // The joined phrase stays the target even when another word was marked too.
    ['My {{friend}} kept {{turning}} the offer {{down}} all week.', 'turn down', ['turning down'], 'My [[friend]] kept {{turning the offer down}} all week.'],
    // A target that already holds the whole phrase keeps it; a neighbor repeating one of its words becomes a lookup.
    ['{{In the end}}, {{in}} my view, it all worked out fine.', 'in the end', [], '{{In the end}}, [[in]] my view, it all worked out fine.'],
    // Too far apart to be one phrase: the target stays on the verb.
    ['I {{turned}} that whole crazy job offer {{down}} last week.', 'turn down', ['turned down'], 'I {{turned}} that whole crazy job offer [[down]] last week.'],
    // An inflection the forms don't list still beats another marked word.
    ['The {{river}} rose over its {{banks}} overnight, no joke.', 'bank', [], 'The [[river]] rose over its {{banks}} overnight, no joke.'],
  ];
  for (const [input, word, forms, expected] of cases) {
    const repaired = repairGeneratedExample(input, word, forms);
    assert.equal(repaired, expected, input);
    assert.equal(isValidGeneratedExample(repaired), true, repaired);
  }
});

test('only schema fields survive normalization, so a stray key cannot spoof a pipeline marker', () => {
  const normalized = normalizeVocabCard(completeCard({
    advancedEnrichment: { version: 99 },
    id: 'model-chosen-id',
    imageUrl: 'data:image/png;base64,AAAA',
    srs: { nextReview: 0 },
  }), 'bank', 1234);
  assert.ok(normalized);
  assert.deepEqual(Object.keys(normalized).sort(), [
    'antonyms', 'chinese', 'confusables', 'definition', 'examples', 'forms', 'history', 'imagePrompt',
    'ipa', 'mnemonic', 'register', 'sense', 'synonyms', 'usageAudit', 'word', 'wordFamily',
  ]);
});

test('a register label shorter than 10 characters is dropped; live analysis accepts the card without one', () => {
  const card = normalizeVocabCard(completeCard({ register: 'formal' }), 'bank', 1234);
  assert.equal(REGISTER_MINIMUM, 10);
  assert.ok(card);
  assert.equal(card.register, '');
  assert.deepEqual(vocabValidationIssues(card, { optionalRegister: true }), []);
  assert.deepEqual(vocabValidationIssues(card), ['"register" must be a string of at least 10 characters']);
  assert.equal(hasCompleteGeneratedVocabMetadata(card), false);
  assert.equal(hasCompleteGeneratedVocabMetadata(card, { optionalRegister: true }), true);
  // A note that is present still has to be a real one.
  assert.deepEqual(vocabValidationIssues({ ...card, register: 'formal' }, { optionalRegister: true }),
    ['"register" must be a string of at least 10 characters']);
});

test('a card\'s usage audit is judged by the stored-item contract in usage-audit.ts', () => {
  const card = normalizeVocabCard(completeCard(), 'bank', 1234);
  assert.ok(card);
  assert.equal(hasCompleteGeneratedVocabMetadata(card), true);
  assert.equal(hasCompleteGeneratedVocabMetadata({ ...card, usageAudit: { ...card.usageAudit, originalText: 'banks' } }), true);
  const usageIssue = '"usageAudit" must have a valid status, reason and confidence';
  for (const usageAudit of [
    { ...card.usageAudit, reason: '   ' },
    { ...card.usageAudit, reason: 'x'.repeat(1_001) },
    { ...card.usageAudit, originalText: '' },
    { ...card.usageAudit, auditedAt: '1234' },
    { ...card.usageAudit, status: 'archaic' },
    undefined,
  ]) {
    assert.ok(vocabValidationIssues({ ...card, usageAudit }).includes(usageIssue), JSON.stringify(usageAudit));
  }
});

test('validation issues name every failing field of a card', () => {
  const issues = vocabValidationIssues({
    ...normalizeVocabCard(completeCard(), 'bank', 1234),
    chinese: 'bank',
    ipa: 'bank',
    mnemonic: '',
    examples: ['I stopped by the {{bank}} after work to deposit my paycheck.'],
  });
  assert.deepEqual(issues, [
    '"mnemonic" must be a string of at least 10 characters',
    '"chinese" must contain Chinese characters',
    '"ipa" must be exactly one American IPA transcription wrapped in slashes, like /ˈbæŋk/',
    '"examples" must contain exactly 2 sentences (found 1)',
  ]);
});

test('an example needs one plain target, at most four lookups and no stray brackets', () => {
  const samples: Array<[unknown, boolean]> = [
    ['I stopped by the {{bank}} after work to deposit my paycheck.', true],
    ['I stopped by the {{bank}} after [[work]] to [[deposit]] my [[paycheck]], [[honestly]].', true],
    ['I stopped by the bank after work to deposit my paycheck.', false],
    ['The {{river}} overflowed its {{bank}} after the storm.', false],
    ['Short {{bank}}.', false],
    [`The {{bank}} ${'really '.repeat(150)}closed.`, false],
    ['A [[a1]] [[b2]] [[c3]] [[d4]] [[e5]] {{bank}} sentence here.', false],
    ['I stopped by the {{bank}} after [[ ]] work today, honestly.', false],
    ['I stopped by the {{bank}} after work { to deposit my paycheck.', false],
    ['I stopped by the {{bank}} after work [sic] to deposit my paycheck.', false],
    ['I stopped by the {{[[bank]]}} after work to deposit my paycheck.', false],
    ['I stopped by the {{ }} after work to deposit my paycheck.', false],
    [42, false],
  ];
  for (const [sample, valid] of samples) {
    assert.equal(isValidGeneratedExample(sample), valid, String(sample));
    assert.equal(exampleIssues(sample).length === 0, valid, String(sample));
  }
  assert.deepEqual(exampleIssues('The {{river}} overflowed its {{bank}} after the storm.'), [
    'must wrap the studied word in {{double curly braces}} exactly once (found 2)',
  ]);
});

test('example-set issues cover count, per-example problems and duplicates', () => {
  const valid = 'I stopped by the {{bank}} after work to deposit my paycheck.';
  assert.deepEqual(exampleSetIssues('not a list'), ['"examples" must be an array of exactly 2 sentences']);
  assert.deepEqual(exampleSetIssues([valid]), ['"examples" must contain exactly 2 sentences (found 1)']);
  assert.deepEqual(exampleSetIssues([valid, valid]), ['the two examples must be different sentences']);
  assert.deepEqual(exampleSetIssues([valid, 'No target in this sentence at all, sadly.']), [
    'example 2 must wrap the studied word in {{double curly braces}} exactly once (found 0)',
  ]);
  assert.deepEqual(exampleSetIssues([valid, 'The {{bank}} approved our mortgage sooner than I expected.']), []);
});
