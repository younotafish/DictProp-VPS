const string = (value, max = 12_000) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const stringList = (value, { min = 0, max = 12 } = {}) =>
  Array.isArray(value) && value.length >= min && value.length <= max &&
  value.every(item => string(item, 2_000));
const slashIpa = value => string(value, 2_000) && /^\/[^/\n]+\/$/.test(value.trim());

export function sentenceGrammarExcerptMatchesText(text, excerpt) {
  if (text.includes(excerpt)) return true;
  // American punctuation can place the sentence-final mark inside a closing quote,
  // even when the quoted grammar excerpt naturally omits that final mark.
  const withoutSentenceFinalPunctuation = text.replace(/([.!?])([\u201d\u2019"'])$/u, '$2');
  if (withoutSentenceFinalPunctuation.includes(excerpt)) return true;
  const withoutQuotedPunctuation = value => value.replace(/[,.;:!?](?=[\u201d\u2019"'])/gu, '');
  const withoutLineBreakMarkers = value => withoutQuotedPunctuation(value).replace(/\s+\/\s+/gu, ' ');
  return withoutLineBreakMarkers(withoutSentenceFinalPunctuation)
    .includes(withoutLineBreakMarkers(excerpt));
}

export const sentenceGrammarSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['structure', 'points'],
  properties: {
    structure: { type: 'string', minLength: 1, maxLength: 4_000 },
    points: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'excerpt', 'explanation'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 300 },
          excerpt: { type: 'string', minLength: 1, maxLength: 1_000 },
          explanation: { type: 'string', minLength: 1, maxLength: 4_000 },
        },
      },
    },
  },
};

export const detailedSentenceAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['translation', 'americanEnglish', 'terms', 'pronunciation', 'grammar', 'imagePrompt'],
  properties: {
    translation: { type: 'string', minLength: 1, maxLength: 12_000 },
    americanEnglish: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'explanation', 'evidence'],
      properties: {
        status: { type: 'string', enum: ['american', 'shared', 'not_american'] },
        explanation: { type: 'string', minLength: 1, maxLength: 4_000 },
        evidence: {
          type: 'array', minItems: 1, maxItems: 6,
          items: { type: 'string', minLength: 1, maxLength: 2_000 },
        },
      },
    },
    terms: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'chinese', 'ipa', 'originalMeaning', 'synonyms', 'antonyms', 'examples', 'historicalEvolution'],
        properties: {
          term: { type: 'string', minLength: 1, maxLength: 300 },
          chinese: { type: 'string', minLength: 1, maxLength: 1_000 },
          ipa: { type: 'string', minLength: 3, maxLength: 500 },
          originalMeaning: { type: 'string', minLength: 1, maxLength: 4_000 },
          synonyms: {
            type: 'array', minItems: 1, maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 2_000 },
          },
          antonyms: {
            type: 'array', maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 2_000 },
          },
          examples: {
            type: 'array', minItems: 2, maxItems: 2,
            items: { type: 'string', minLength: 1, maxLength: 2_000 },
          },
          historicalEvolution: { type: 'string', minLength: 1, maxLength: 4_000 },
        },
      },
    },
    pronunciation: {
      type: 'object',
      additionalProperties: false,
      required: [
        'slowIpa', 'fastIpa', 'carefulSpeakerGuide', 'fastSpeechFeatures',
        'intonationAndChunking', 'keyDifference',
      ],
      properties: {
        slowIpa: { type: 'string', minLength: 3, maxLength: 2_000 },
        fastIpa: { type: 'string', minLength: 3, maxLength: 2_000 },
        carefulSpeakerGuide: { type: 'string', minLength: 1, maxLength: 4_000 },
        fastSpeechFeatures: {
          type: 'array', minItems: 1, maxItems: 6,
          items: { type: 'string', minLength: 1, maxLength: 2_000 },
        },
        intonationAndChunking: { type: 'string', minLength: 1, maxLength: 4_000 },
        keyDifference: { type: 'string', minLength: 1, maxLength: 4_000 },
      },
    },
    grammar: sentenceGrammarSchema,
    imagePrompt: { type: 'string', minLength: 1, maxLength: 4_000 },
  },
};

export function isSentenceGrammarAnalysis(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    string(value.structure, 4_000) && Array.isArray(value.points) && value.points.length <= 12 &&
    value.points.every(point => point && typeof point === 'object' && !Array.isArray(point) &&
      string(point.label, 300) && string(point.excerpt, 1_000) && string(point.explanation, 4_000));
}

export function isDetailedSentenceAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const american = value.americanEnglish;
  const pronunciation = value.pronunciation;
  const grammar = value.grammar;
  if (!string(value.translation) || !string(value.imagePrompt, 4_000)) return false;
  if (!american || typeof american !== 'object' || Array.isArray(american) ||
      !['american', 'shared', 'not_american'].includes(american.status) ||
      !string(american.explanation, 4_000) || !stringList(american.evidence, { min: 1, max: 6 })) return false;
  if (!pronunciation || typeof pronunciation !== 'object' || Array.isArray(pronunciation) ||
      !slashIpa(pronunciation.slowIpa) || !slashIpa(pronunciation.fastIpa) ||
      !string(pronunciation.carefulSpeakerGuide, 4_000) ||
      !stringList(pronunciation.fastSpeechFeatures, { min: 1, max: 6 }) ||
      !string(pronunciation.intonationAndChunking, 4_000) ||
      !string(pronunciation.keyDifference, 4_000)) return false;
  if (value.naturalSpeechIpa !== undefined &&
      (!string(value.naturalSpeechIpa, 2_000) || value.naturalSpeechIpa.trim() !== pronunciation.fastIpa.trim())) return false;
  if (!isSentenceGrammarAnalysis(grammar)) return false;
  if (!Array.isArray(value.terms) || value.terms.length > 20) return false;
  return value.terms.every(term => term && typeof term === 'object' && !Array.isArray(term) &&
    string(term.term, 300) && string(term.chinese, 1_000) && string(term.ipa, 500) &&
    string(term.originalMeaning, 4_000) && stringList(term.synonyms, { min: 1, max: 12 }) &&
    stringList(term.antonyms, { max: 12 }) && stringList(term.examples, { min: 2, max: 2 }) &&
    string(term.historicalEvolution, 4_000));
}

export function normalizeDetailedSentenceAnalysis(value, preservedGrammar, label = 'sentence') {
  const analysis = {
    ...value,
    ...(preservedGrammar ? { grammar: preservedGrammar } : {}),
    naturalSpeechIpa: value?.pronunciation?.fastIpa,
  };
  if (!isDetailedSentenceAnalysis(analysis)) throw new Error(`${label}: incomplete detailed sentence analysis`);
  return analysis;
}

export const DETAILED_SENTENCE_ANALYSIS_INSTRUCTION = `You are an expert American English lexicographer, grammarian, pronunciation coach, and an exacting teacher for an advanced Chinese-speaking learner. Analyze only the supplied English sentences. Be context-specific, thorough, and factually conservative.

For every sentence, return these fields:
1. translation: a precise, natural Simplified Chinese translation of the complete sentence. Preserve tense, modality, tone, register, implied relationships, and idiomatic force.
2. americanEnglish: status is american, shared, or not_american. explanation must begin with Yes or No and give a nuanced verdict about whether the complete wording is natural in present-day educated American English and in what context or register. evidence must contain 1-6 non-redundant, bullet-ready reasons tied to exact words or constructions. Distinguish natural American usage from uniquely American usage. If wording is not natural American English, give the current American equivalent.
3. terms: explain every uncommon or non-obvious word, idiom, phrasal verb, fixed phrase, metaphorical use, or central literary/professional expression an upper-intermediate Chinese-speaking learner may need. Include the studied expression when useful. Do not omit a meaningful B2+ term merely because an advanced reader may recognize it; do not pad with elementary function words. Prefer the longest meaningful phrase and do not duplicate components. Each term needs its context-specific Simplified Chinese translation, rhotic General American IPA, core contextual meaning plus literal/earlier meaning when figurative, sense-matched synonyms and antonyms, exactly two distinct natural modern American examples, and a conservative historical-evolution note. Antonyms may be empty only when no natural opposite exists. Keep meaning, examples, and historical chronology in their own fields.
4. pronunciation: slowIpa is deliberate but natural rhotic General American IPA for the complete sentence with clear boundaries. fastIpa is complete fluent connected-speech IPA with ordinary weak forms, reduction, linking, assimilation, release, and flapping where they genuinely occur. Enclose each transcription in one pair of slashes, preserve every meaning-bearing word, and avoid British RP, narrow regional features, eye dialect, or exaggerated deletion. carefulSpeakerGuide uses ordinary spelling, hyphens, / between thought groups, and CAPITALS for primary stress. fastSpeechFeatures contains 1-6 sentence-specific observations naming the exact source span, its process, and resulting sound. intonationAndChunking gives the complete sentence in thought groups with / and useful rise/fall arrows, then identifies the information focus. keyDifference contrasts careful and fluent delivery in this exact sentence.
5. grammar: structure maps the sentence's main and subordinate clauses, phrases, coordination, and ellipsis in source order. points cover every construction an advanced learner needs to parse correctly, including tense/aspect, modality, clause relationships, nonfinite or reduced clauses, reference, word order, agreement, modification, coordination, ellipsis, and information structure when relevant. Each point names the feature, copies the shortest exact excerpt, and explains how it works here, what it contributes, and why this form is used instead of a plausible alternative. Do not pad a simple sentence with trivial points.
6. imagePrompt: a production-ready prompt for one realistic photorealistic 16:9 photograph whose central action or relationship makes the complete contextual meaning inferable at a glance. Specify people, setting, camera distance, composition, and natural lighting. Depict an idiom's intended meaning, not a misleading literal origin. Prohibit illustration, animation, 3D render, collage, split screen, typography, captions, logos, watermarks, and visible text.

Everything must be English except translation and each term's chinese field. IPA must use IPA symbols rather than respelling. Synonyms and antonyms must match the contextual sense. Examples must not quote or merely paraphrase the source. State uncertainty instead of inventing an etymology. Never emit placeholder content, repeat a term or example, or use a schema field name as content. When an input includes preservedGrammar, copy that grammar object exactly into the output rather than revising it. Copy every itemIndex exactly, return every input once, and output only schema-valid JSON.`;
