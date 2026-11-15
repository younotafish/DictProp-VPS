import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasCompleteSentenceAnalysis,
  hasSentenceGrammarAnalysis,
  isSentenceGrammarAnalysis,
  isSentenceAnalysis,
  sentenceAnalysisValidationIssues,
} from '../src/sentence-analysis.js';
import {
  expandAbbreviatedGrammarExcerpt,
  isDetailedSentenceAnalysis,
  isSentenceAnalysis as isOfflineSentenceAnalysis,
  recoverExactGrammarExcerpt,
  sentenceGrammarExcerptMatchesText,
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
  assert.deepEqual(
    cases.map(value => isSentenceAnalysis(value)),
    cases.map(value => isOfflineSentenceAnalysis(value)),
  );
});

test('grammar excerpts may omit sentence-final punctuation inside a closing quote', () => {
  const text = 'Speakers retain the r in words such as “car” and “hard.”';
  const excerpt = 'words such as “car” and “hard”';
  assert.equal(sentenceGrammarExcerptMatchesText(text, excerpt), true);
  assert.equal(sentenceGrammarExcerptMatchesText(text, 'words such as “car” and “soft”'), false);
});

test('grammar excerpts may omit punctuation inside a closing quote', () => {
  const text = 'Rather than being a book for “the season only,” it became a book for all seasons.';
  const excerpt = 'Rather than being a book for “the season only”';
  assert.equal(sentenceGrammarExcerptMatchesText(text, excerpt), true);
  assert.equal(sentenceGrammarExcerptMatchesText(text, 'a book for “all seasons”'), false);
});

test('grammar excerpts may treat spaced slashes as poetic line breaks', () => {
  const text = '“The first snows / floated down and silenced / all trace of the world.”';
  const excerpt = 'floated down and silenced all trace of the world';
  assert.equal(sentenceGrammarExcerptMatchesText(text, excerpt), true);
  assert.equal(sentenceGrammarExcerptMatchesText(text, 'floated up and silenced all trace'), false);
});

test('offline generation expands abbreviated grammar excerpts into exact contiguous quotes', () => {
  const text = 'The promise of easy money turned out to be totally illusive.';
  assert.equal(
    expandAbbreviatedGrammarExcerpt(text, 'The promise ... turned out'),
    'The promise of easy money turned out',
  );
  assert.equal(expandAbbreviatedGrammarExcerpt(text, 'easy money'), 'easy money');
  assert.equal(expandAbbreviatedGrammarExcerpt(text, 'missing ... words'), 'missing ... words');
});

test('offline generation recovers exact source punctuation and omitted modifiers', () => {
  assert.equal(
    recoverExactGrammarExcerpt(
      'I was seven—it felt like a huge deal.',
      '— it felt like a huge deal',
    ),
    'it felt like a huge deal',
  );
  assert.equal(
    recoverExactGrammarExcerpt("We led, but we couldn't hold onto it.", 'but we couldn’t hold onto it'),
    "but we couldn't hold onto it",
  );
  assert.equal(
    recoverExactGrammarExcerpt("We're gonna catch the Celtics game tonight.", 'catch the game'),
    'catch the Celtics game',
  );
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
