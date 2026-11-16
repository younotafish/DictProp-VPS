// The detailed sentence analysis the cycle asks the model for: its schema and prompt, and the repairs for grammar
// excerpts the model abbreviates or misquotes. The import contract the analyses must meet is the server's own, from
// server/src/sentence-analysis.ts.
import {
  hasCompleteSentenceAnalysis,
  isSentenceAnalysis,
  isSentenceGrammarAnalysis,
  sentenceAnalysisValidationIssues,
} from '../../server/src/sentence-analysis.ts';

// isSentenceAnalysis also admits the legacy shape that production-covered analyses may keep as transport metadata for
// a missing image, whose newer complete analysis the server preserves; isDetailedSentenceAnalysis is the complete
// analysis every new one must be.
export { hasCompleteSentenceAnalysis as isDetailedSentenceAnalysis, isSentenceAnalysis, isSentenceGrammarAnalysis };

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

export function expandAbbreviatedGrammarExcerpt(text, excerpt) {
  const source = String(text || '');
  const value = String(excerpt || '');
  if (!/(?:\.{3}|…)/u.test(value)) return value;
  const segments = value.split(/\s*(?:\.{3}|…)\s*/u).filter(Boolean);
  if (segments.length < 2) return value;

  let best = '';
  let start = source.indexOf(segments[0]);
  while (start >= 0) {
    let cursor = start + segments[0].length;
    let end = cursor;
    let matched = true;
    for (const segment of segments.slice(1)) {
      const next = source.indexOf(segment, cursor);
      if (next < 0) {
        matched = false;
        break;
      }
      cursor = next + segment.length;
      end = cursor;
    }
    if (matched) {
      const candidate = source.slice(start, end);
      if (!best || candidate.length < best.length) best = candidate;
    }
    start = source.indexOf(segments[0], start + 1);
  }
  return best || value;
}

function grammarTokens(value) {
  const tokens = [];
  const pattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  for (const match of String(value || '').matchAll(pattern)) {
    tokens.push({
      value: match[0].toLowerCase().replace(/’/gu, "'"),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

export function recoverExactGrammarExcerpt(text, excerpt) {
  const source = String(text || '');
  const expanded = expandAbbreviatedGrammarExcerpt(source, excerpt);
  if (sentenceGrammarExcerptMatchesText(source, expanded)) return expanded;

  const sourceTokens = grammarTokens(source);
  const excerptTokens = grammarTokens(expanded);
  if (excerptTokens.length === 0) return expanded;
  let best = '';
  for (let start = 0; start < sourceTokens.length; start++) {
    if (sourceTokens[start].value !== excerptTokens[0].value) continue;
    let sourceIndex = start + 1;
    let excerptIndex = 1;
    while (sourceIndex < sourceTokens.length && excerptIndex < excerptTokens.length) {
      if (sourceTokens[sourceIndex].value === excerptTokens[excerptIndex].value) excerptIndex++;
      sourceIndex++;
    }
    if (excerptIndex !== excerptTokens.length) continue;
    const endToken = sourceTokens[sourceIndex - 1];
    const extraTokens = sourceIndex - start - excerptTokens.length;
    const candidate = source.slice(sourceTokens[start].start, endToken.end);
    if (extraTokens <= 8 && candidate.length <= 1_000 && (!best || candidate.length < best.length)) {
      best = candidate;
    }
  }
  return best || expanded;
}

const sentenceGrammarSchema = {
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

export function normalizeDetailedSentenceAnalysis(value, preservedGrammar, label = 'sentence') {
  const analysis = {
    ...value,
    ...(preservedGrammar ? { grammar: preservedGrammar } : {}),
    naturalSpeechIpa: value?.pronunciation?.fastIpa,
  };
  if (!hasCompleteSentenceAnalysis(analysis)) {
    // The server's reasons, phrased for the model's retry. They unwrap an answer a provider wrapped in an envelope,
    // so a complete analysis inside one has none.
    const issues = sentenceAnalysisValidationIssues(analysis);
    throw new Error(`${label}: ${issues.join('; ') || 'incomplete detailed sentence analysis'}`);
  }
  return analysis;
}

export const DETAILED_SENTENCE_ANALYSIS_INSTRUCTION = `You are an expert American English lexicographer, grammarian, pronunciation coach, and an exacting teacher for an advanced Chinese-speaking learner. Analyze only the supplied English sentences. Be context-specific, thorough, and factually conservative.

For every sentence, return these fields:
1. translation: a precise, natural Simplified Chinese translation of the complete sentence. Preserve tense, modality, tone, register, implied relationships, and idiomatic force.
2. americanEnglish: status is american, shared, or not_american. explanation must begin with Yes or No and give a nuanced verdict about whether the complete wording is natural in present-day educated American English and in what context or register. evidence must contain 1-6 non-redundant, bullet-ready reasons tied to exact words or constructions. Distinguish natural American usage from uniquely American usage. If wording is not natural American English, give the current American equivalent.
3. terms: explain every uncommon or non-obvious word, idiom, phrasal verb, fixed phrase, metaphorical use, or central literary/professional expression an upper-intermediate Chinese-speaking learner may need. Include the studied expression when useful. Do not omit a meaningful B2+ term merely because an advanced reader may recognize it; do not pad with elementary function words. Prefer the longest meaningful phrase and do not duplicate components. Each term needs its context-specific Simplified Chinese translation, rhotic General American IPA, core contextual meaning plus literal/earlier meaning when figurative, sense-matched synonyms and antonyms, exactly two distinct natural modern American examples, and a conservative historical-evolution note. Antonyms may be empty only when no natural opposite exists. Keep meaning, examples, and historical chronology in their own fields.
4. pronunciation: slowIpa is deliberate but natural rhotic General American IPA for the complete sentence with clear boundaries. fastIpa is complete fluent connected-speech IPA with ordinary weak forms, reduction, linking, assimilation, release, and flapping where they genuinely occur. Enclose each transcription in one pair of slashes, preserve every meaning-bearing word, and avoid British RP, narrow regional features, eye dialect, or exaggerated deletion. carefulSpeakerGuide uses ordinary spelling, hyphens, / between thought groups, and CAPITALS for primary stress. fastSpeechFeatures contains 1-6 sentence-specific observations naming the exact source span, its process, and resulting sound. intonationAndChunking gives the complete sentence in thought groups with / and useful rise/fall arrows, then identifies the information focus. keyDifference contrasts careful and fluent delivery in this exact sentence.
5. grammar: structure maps the sentence's main and subordinate clauses, phrases, coordination, and ellipsis in source order. points cover every construction an advanced learner needs to parse correctly, including tense/aspect, modality, clause relationships, nonfinite or reduced clauses, reference, word order, agreement, modification, coordination, ellipsis, and information structure when relevant. Each point names the feature, copies the shortest exact contiguous excerpt character-for-character, and explains how it works here, what it contributes, and why this form is used instead of a plausible alternative. Never abbreviate an excerpt with "..." or "…", change straight/curly punctuation, add spacing around a dash, omit a modifier inside the span, or combine discontiguous words. Do not pad a simple sentence with trivial points.
6. imagePrompt: a production-ready prompt for one realistic photorealistic 16:9 photograph whose central action or relationship makes the complete contextual meaning inferable at a glance. Specify people, setting, camera distance, composition, and natural lighting. Depict an idiom's intended meaning, not a misleading literal origin. Prohibit illustration, animation, 3D render, collage, split screen, typography, captions, logos, watermarks, and visible text.

Everything must be English except translation and each term's chinese field. IPA must use IPA symbols rather than respelling. Synonyms and antonyms must match the contextual sense. Examples must not quote or merely paraphrase the source. State uncertainty instead of inventing an etymology. Never emit placeholder content, repeat a term or example, or use a schema field name as content. When an input includes preservedGrammar, copy that grammar object exactly into the output rather than revising it. Copy every itemIndex exactly, return every input once, and output only schema-valid JSON.`;
