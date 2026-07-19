import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSentenceAnalysis,
  SENTENCE_ANALYSIS_INSTRUCTION,
  sentenceAnalysisUserPrompt,
} from '../src/sentence-analysis.js';

const validAnalysis = {
  translation: '他终于把真相说了出来。',
  naturalSpeechIpa: '/hi ˈfaɪnəli keɪm kliːn/',
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
  const american = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"americanEnglish"');
  const terms = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"terms"');
  const image = SENTENCE_ANALYSIS_INSTRUCTION.indexOf('"imagePrompt"');
  assert.ok(translation >= 0 && translation < naturalSpeechIpa && naturalSpeechIpa < american && american < terms && terms < image);
  assert.match(SENTENCE_ANALYSIS_INSTRUCTION, /Everything must be English except/);
  assert.match(SENTENCE_ANALYSIS_INSTRUCTION, /rhotic General American/);
  assert.match(SENTENCE_ANALYSIS_INSTRUCTION, /connected speech/);
  assert.match(SENTENCE_ANALYSIS_INSTRUCTION, /photorealistic 16:9/);
  assert.match(sentenceAnalysisUserPrompt('  He came clean.  '), /"He came clean\."/);
});
