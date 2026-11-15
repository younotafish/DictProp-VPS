// Fixtures that several test files share. Each spells out a contract (a complete card, a complete analysis), so it
// lives here once: when the contract gains a required field, only this file changes.

/** A stored vocab card that every completeness check accepts. */
export const completeVocab = {
  id: 'word',
  word: 'word',
  sense: 'noun: unit of language',
  chinese: '词',
  ipa: '/wɝd/',
  definition: 'A distinct unit of language with meaning or grammatical function.',
  forms: ['word', 'words'],
  wordFamily: [{ word: 'wording', pos: 'noun', chinese: '措辞' }],
  history: 'From Old English word, with cognates across the Germanic languages.',
  register: 'Common in every register of present-day English.',
  mnemonic: 'A word is one unit you can put into a sentence.',
  imagePrompt: 'A clean educational icon showing one highlighted word in a row of language symbols.',
  synonyms: [],
  antonyms: [],
  confusables: [],
  examples: [
    'I need one better {{word}} before I send this message to the whole team.',
    'That {{word}} makes the instructions way easier to understand.',
  ],
  usageAudit: {
    status: 'current_general',
    reason: 'A basic and current term throughout American English.',
    confidence: 'high',
    auditedAt: 1,
  },
};

/** A detailed sentence analysis that every completeness check accepts. */
export const completeAnalysis = {
  translation: '这是一个例句。',
  naturalSpeechIpa: '/ðɪs ɪz ə tɛst/',
  grammar: { structure: 'A simple declarative clause.', points: [] },
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. This is natural in American English.',
    evidence: ['The wording is current and idiomatic.'],
  },
  terms: [],
  pronunciation: {
    slowIpa: '/ðɪs ɪz ə tɛst/',
    fastIpa: '/ðɪs ɪz ə tɛst/',
    carefulSpeakerGuide: 'this IS a TEST',
    fastSpeechFeatures: ['The article is reduced in fluent speech.'],
    intonationAndChunking: 'Use one thought group with a final fall.',
    keyDifference: 'Fluent speech reduces the unstressed article.',
  },
  imagePrompt: 'A photorealistic wide image of a student completing a short test at a desk, with no visible text.',
};

/** A model's card for "bank" (finance) that passes validation; `overrides` replaces fields in place. */
export const bankCard = (overrides: Record<string, unknown> = {}) => ({
  word: 'bank',
  sense: 'noun: finance',
  chinese: '银行',
  ipa: '/bæŋk/',
  definition: 'A business that keeps and lends money.',
  forms: ['bank', 'banks'],
  wordFamily: [{ word: 'banker', pos: 'noun', chinese: '银行家' }],
  synonyms: ['lender'],
  antonyms: [],
  confusables: ['bench'],
  examples: [
    'I stopped by the {{bank}} after work to deposit my paycheck.',
    'The {{bank}} approved our mortgage sooner than I expected.',
  ],
  history: 'From Italian banca, the bench where money changers worked.',
  register: 'Everyday',
  mnemonic: 'A bench (banca) where the money sat.',
  imagePrompt: 'A realistic neighborhood bank counter with a customer depositing a paycheck, natural daylight.',
  usageAudit: { status: 'current_general', reason: 'Normal in American English.', confidence: 'high' },
  ...overrides,
});

/** A never-reviewed SRS record in the stored shape. */
export const srs = (id: string, type: string) => ({
  id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0,
});
