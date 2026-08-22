import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractSentenceAnalysis,
  extractSentenceGrammarAnalysis,
  hasCompleteSentenceAnalysis,
  hasSentenceGrammarAnalysis,
  isSentenceGrammarAnalysis,
  isSentenceAnalysis,
  SENTENCE_ANALYSIS_INSTRUCTION,
  SENTENCE_GRAMMAR_INSTRUCTION,
  sentenceGrammarUserPrompt,
  sentenceGrammarExcerptMatchesText,
  sentenceAnalysisUserPrompt,
  sentenceAnalysisValidationIssues,
} from '../src/sentence-analysis.js';
import {
  isDetailedSentenceAnalysis,
  sentenceGrammarExcerptMatchesText as offlineSentenceGrammarExcerptMatchesText,
} from '../../scripts/offline/sentence-analysis-contract.mjs';

const validAnalysis = {
  translation: '他终于把真相说了出来。',
  naturalSpeechIpa: '/hi ˈfaɪnəli keɪm kliːn/',
  grammar: {
    structure: 'A simple declarative clause with a subject, adverb, and intransitive phrasal predicate.',
    points: [{
      label: 'Simple past',
      excerpt: 'came',
      explanation: 'The simple past presents the admission as a completed event.',
    }],
  },
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. The wording is natural in educated American English and shared across major varieties.',
    evidence: ['Come clean is a current idiom in both American and British English.'],
  },
  terms: [{
    term: 'come clean',
    chinese: '坦白；说出真相',
    ipa: '/kʌm kliːn/',
    originalMeaning: 'To admit the truth after concealing it; clean suggests removing moral concealment.',
    synonyms: ['confess', 'own up'],
    antonyms: ['cover up'],
    examples: ['You should come clean before they find out.', 'She came clean about the mistake.'],
    historicalEvolution: 'The figurative sense developed from the association of cleanliness with honesty.',
  }],
  pronunciation: {
    slowIpa: '/hi ˈfaɪnəli keɪm kliːn/',
    fastIpa: '/hi ˈfaɪnəli keɪm kliːn/',
    carefulSpeakerGuide: 'he FIN-al-ly / came CLEAN',
    fastSpeechFeatures: ['finally came links the final vowel into the following consonant without a pause.'],
    intonationAndChunking: 'He finally came clean ↘ / with the main fall on clean.',
    keyDifference: 'Careful speech separates each word; fluent speech links the phrase into one thought group.',
  },
  imagePrompt: 'A photorealistic wide shot of a person admitting the truth to a close friend in a quiet kitchen, natural window light, no visible text.',
};

test('sentence analysis accepts the durable structured format', () => {
  assert.equal(isSentenceAnalysis(validAnalysis), true);
  assert.equal(hasCompleteSentenceAnalysis(validAnalysis), true);
  assert.equal(hasSentenceGrammarAnalysis(validAnalysis), true);
  assert.equal(isSentenceGrammarAnalysis(validAnalysis.grammar), true);
  const { grammar: _grammar, ...legacyAnalysis } = validAnalysis;
  assert.equal(isSentenceAnalysis(legacyAnalysis), true);
  assert.equal(hasSentenceGrammarAnalysis(legacyAnalysis), false);
  assert.equal(isSentenceAnalysis({ ...validAnalysis, grammar: { structure: 'Clause.', points: [{}] } }), false);
  assert.equal(isSentenceAnalysis({ ...validAnalysis, naturalSpeechIpa: '' }), false);
  assert.equal(isSentenceAnalysis({ ...validAnalysis, naturalSpeechIpa: undefined }), true);
  assert.equal(isSentenceAnalysis({ ...validAnalysis, translation: '' }), false);
  assert.equal(isSentenceAnalysis({
    ...validAnalysis,
    americanEnglish: { status: 'maybe', explanation: 'Unclear.' },
  }), false);
  assert.equal(isSentenceAnalysis({
    ...validAnalysis,
    terms: [{ ...validAnalysis.terms[0], synonyms: 'confess' }],
  }), false);
});

test('server and offline detailed-analysis predicates stay in parity', () => {
  const cases = [
    validAnalysis,
    { ...validAnalysis, pronunciation: undefined },
    { ...validAnalysis, americanEnglish: { ...validAnalysis.americanEnglish, evidence: [] } },
    { ...validAnalysis, terms: [{ ...validAnalysis.terms[0], examples: ['Only one.'] }] },
    { ...validAnalysis, naturalSpeechIpa: '/different/' },
  ];
  assert.deepEqual(
    cases.map(value => hasCompleteSentenceAnalysis(value)),
    cases.map(value => isDetailedSentenceAnalysis(value)),
  );
  assert.deepEqual(cases.map(value => hasCompleteSentenceAnalysis(value)), [true, false, false, false, false]);
});

test('grammar response extraction tolerates harmless provider wrappers', () => {
  const grammar = validAnalysis.grammar;
  assert.deepEqual(extractSentenceGrammarAnalysis({ grammar }), grammar);
  assert.deepEqual(extractSentenceGrammarAnalysis(grammar), grammar);
  assert.deepEqual(extractSentenceGrammarAnalysis({ analysis: { grammar } }), grammar);
  assert.deepEqual(extractSentenceGrammarAnalysis({ '': JSON.stringify({ grammar }) }), grammar);
  assert.deepEqual(extractSentenceGrammarAnalysis({ content: `\`\`\`json\n${JSON.stringify({ grammar })}\n\`\`\`` }), grammar);
  assert.equal(extractSentenceGrammarAnalysis({ grammar: { structure: 'Clause.', points: [{}] } }), null);
});

test('grammar excerpts may omit sentence-final punctuation inside a closing quote', () => {
  const text = 'Speakers retain the r in words such as “car” and “hard.”';
  const excerpt = 'words such as “car” and “hard”';
  assert.equal(sentenceGrammarExcerptMatchesText(text, excerpt), true);
  assert.equal(offlineSentenceGrammarExcerptMatchesText(text, excerpt), true);
  assert.equal(sentenceGrammarExcerptMatchesText(text, 'words such as “car” and “soft”'), false);
});

test('grammar excerpts may omit punctuation inside a closing quote', () => {
  const text = 'Rather than being a book for “the season only,” it became a book for all seasons.';
  const excerpt = 'Rather than being a book for “the season only”';
  assert.equal(sentenceGrammarExcerptMatchesText(text, excerpt), true);
  assert.equal(offlineSentenceGrammarExcerptMatchesText(text, excerpt), true);
  assert.equal(sentenceGrammarExcerptMatchesText(text, 'a book for “all seasons”'), false);
});

test('full analysis extraction tolerates a JSON string under an empty provider key', () => {
  assert.deepEqual(extractSentenceAnalysis({ '': JSON.stringify(validAnalysis) }), validAnalysis);
  assert.deepEqual(extractSentenceAnalysis({ result: { analysis: validAnalysis } }), validAnalysis);
  assert.equal(extractSentenceAnalysis({ '': 'not JSON' }), null);
});

test('full analysis extraction normalizes bounded provider-shape drift', () => {
  const { translation, ...withoutTranslation } = validAnalysis;
  const features = Array.from({ length: 8 }, (_, index) => ({
    span: `source span ${index + 1}`,
    process: `connected-speech process ${index + 1}`,
  }));
  const extracted = extractSentenceAnalysis({
    ...withoutTranslation,
    '': translation,
    americanEnglish: {
      ...validAnalysis.americanEnglish,
      evidence: Array.from({ length: 8 }, (_, index) => `Evidence ${index + 1}`),
    },
    pronunciation: { ...validAnalysis.pronunciation, fastSpeechFeatures: features },
  });
  assert.equal(extracted?.translation, translation);
  assert.equal(extracted?.americanEnglish.evidence.length, 6);
  assert.deepEqual(extracted?.pronunciation.fastSpeechFeatures, features.slice(0, 6).map(feature =>
    `${feature.span}: ${feature.process}`));
});

test('sentence analysis validation reports exact repair instructions', () => {
  const issues = sentenceAnalysisValidationIssues({
    analysis: {
      ...validAnalysis,
      naturalSpeechIpa: undefined,
      terms: [{ ...validAnalysis.terms[0], synonyms: [], examples: ['Only one.'] }],
      pronunciation: { ...validAnalysis.pronunciation, slowIpa: 'missing slashes' },
    },
  });
  assert.ok(issues.includes('terms[0].synonyms must contain at least one string'));
  assert.ok(issues.includes('terms[0].examples must contain exactly two strings'));
  assert.ok(issues.includes('pronunciation.slowIpa must be complete IPA enclosed in slashes'));
});

test('offline prompt fixes field order, language, dialect, and image style', () => {
  const translation = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"translation"');
  const american = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"americanEnglish"');
  const terms = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"terms"');
  const pronunciation = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"pronunciation"');
  const grammar = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"grammar"');
  const image = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"imagePrompt"');
  assert.ok(translation >= 0 && translation < american && american < terms && terms < pronunciation && pronunciation < grammar && grammar < image);
  assert.match(SENTENCE_ANALYSIS_INSTRUCTION, /Everything must be English except/);
  assert.match(SENTENCE_ANALYSIS_INSTRUCTION, /rhotic General American/);
  assert.match(SENTENCE_ANALYSIS_INSTRUCTION, /connected speech/);
  assert.match(SENTENCE_ANALYSIS_INSTRUCTION, /photorealistic 16:9/);
  assert.match(sentenceAnalysisUserPrompt('  He came clean.  '), /"He came clean\."/);
  assert.doesNotMatch(sentenceAnalysisUserPrompt('He {{came}} [[clean]].'), /[{}\[\]]/);
  assert.match(SENTENCE_GRAMMAR_INSTRUCTION, /advanced Chinese-speaking learner/);
  assert.match(sentenceGrammarUserPrompt('  He came clean.  ', '他坦白了。'), /Existing Chinese translation/);
  assert.match(sentenceGrammarUserPrompt('He {{came}} [[clean]].'), /"He came clean\."/);
});
