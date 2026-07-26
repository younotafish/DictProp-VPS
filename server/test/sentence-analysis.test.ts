import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasSentenceGrammarAnalysis,
  isSentenceGrammarAnalysis,
  isSentenceAnalysis,
  SENTENCE_ANALYSIS_INSTRUCTION,
  SENTENCE_GRAMMAR_INSTRUCTION,
  sentenceGrammarUserPrompt,
  sentenceAnalysisUserPrompt,
} from '../src/sentence-analysis.js';

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
    explanation: 'The wording is common across major English varieties.',
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
  imagePrompt: 'A photorealistic wide shot of a person admitting the truth to a close friend in a quiet kitchen, natural window light, no visible text.',
};

test('sentence analysis accepts the durable structured format', () => {
  assert.equal(isSentenceAnalysis(validAnalysis), true);
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

test('offline prompt fixes field order, language, dialect, and image style', () => {
  const translation = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"translation"');
  const naturalSpeechIpa = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"naturalSpeechIpa"');
  const grammar = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"grammar"');
  const american = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"americanEnglish"');
  const terms = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"terms"');
  const image = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"imagePrompt"');
  assert.ok(translation >= 0 && translation < naturalSpeechIpa && naturalSpeechIpa < grammar && grammar < american && american < terms && terms < image);
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
