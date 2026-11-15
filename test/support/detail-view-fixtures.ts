import type { SentenceAnalysis } from '../../types.ts';

/** Fixtures for the card view's tests. A sentence analysis that meets the server's detailed-analysis contract (hasCompleteSentenceAnalysis). */
export const detailedAnalysis: SentenceAnalysis = {
  translation: '他终于把真相说了出来。',
  naturalSpeechIpa: '/hi ˈfaɪnəli keɪm kliːn/',
  grammar: {
    structure: 'A simple declarative clause with a subject, adverb, and intransitive phrasal predicate.',
    points: [{ label: 'Simple past', excerpt: 'came', explanation: 'The simple past presents the admission as a completed event.' }],
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
