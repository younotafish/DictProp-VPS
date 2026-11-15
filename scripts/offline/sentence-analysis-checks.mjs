// The sentence-analysis stage's own logic: the records it sends, and the checks a fresh analysis must pass
// before the cycle accepts it. Those checks are stricter than the import contract in
// sentence-analysis-contract.mjs, which also admits analyses made before them. enrich-sentences.mjs runs it.

import { indexedResults } from './model-stage.mjs';
import {
  isSentenceGrammarAnalysis,
  normalizeDetailedSentenceAnalysis,
  recoverExactGrammarExcerpt,
  sentenceGrammarExcerptMatchesText,
} from './sentence-analysis-contract.mjs';

function validString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedValue(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// The text without its {{target}} and [[lookup]] markers.
export function plainSentence(value) {
  return String(value || '')
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^[\]]+)\]\]/g, '$1');
}

// One or more slash-enclosed transcriptions, with nothing between them but separators and short labels.
export function validTermIpa(value) {
  const ipa = String(value || '').trim();
  const transcriptions = ipa.match(/\/[^/\n]+\//g) || [];
  if (transcriptions.length === 0) return false;
  const annotations = ipa.replace(/\/[^/\n]+\//g, '');
  return !annotations.includes('/') &&
    /^(?:[\s;,:()[\]\-–—]*(?:past|present|plural|singular|also|or|american|us|noun|verb|adjective|adverb|stressed|unstressed)?)*[\s;,:()[\]\-–—]*$/i.test(annotations);
}

// A placeholder, or a schema field's name, given as content.
export function leakedPlaceholder(value) {
  return /^(?:placeholder|tbd|todo|(?:slow\s*ipa|fast\s*ipa|careful\s*speaker\s*guide|original\s*meaning|historical\s*evolution|image\s*prompt)(?:\s+placeholder)?)[.!]?$/i.test(String(value || '').trim());
}

// The base manifest's analyses by sentence id, refusing a manifest with a missing or repeated identity.
export function readBaseAnalyses(base) {
  const baseAnalysisById = new Map();
  if (base?.version !== 1 || !Array.isArray(base.entries)) throw new Error('Base analysis manifest is invalid');
  for (const entry of base.entries) {
    if (typeof entry?.id !== 'string' || !entry.id || baseAnalysisById.has(entry.id) ||
        typeof entry.textHash !== 'string') throw new Error('Base analysis manifest has an invalid identity');
    baseAnalysisById.set(entry.id, entry);
  }
  return baseAnalysisById;
}

// The grammar of an earlier analysis of the same text, kept when every excerpt still quotes the sentence.
export function preservedGrammarFor(baseAnalysisById, sourceRecord) {
  const entry = baseAnalysisById.get(sourceRecord.id);
  if (!entry || entry.textHash !== sourceRecord.textHash) return undefined;
  const grammar = entry.analysis?.grammar ?? entry.grammar;
  if (!isSentenceGrammarAnalysis(grammar)) return undefined;
  const text = plainSentence(sourceRecord.text);
  return grammar.points.every(point => sentenceGrammarExcerptMatchesText(text, point.excerpt)) ? grammar : undefined;
}

// The records the model sees for one batch.
export function analysisRecords(batch, baseAnalysisById) {
  return batch.map((sourceRecord, itemIndex) => {
    const preservedGrammar = preservedGrammarFor(baseAnalysisById, sourceRecord);
    return {
      itemIndex,
      text: plainSentence(sourceRecord.text),
      sourceWord: sourceRecord.sourceWord,
      sourceSense: sourceRecord.sourceSense,
      ...(sourceRecord.contextBefore ? { contextBefore: plainSentence(sourceRecord.contextBefore) } : {}),
      ...(sourceRecord.contextAfter ? { contextAfter: plainSentence(sourceRecord.contextAfter) } : {}),
      ...(preservedGrammar ? { preservedGrammar } : {}),
    };
  });
}

// Returns the normalized analysis, or throws a message the model can act on. With deferGrammarValidation,
// grammar points are left for a later pass to check.
export function validateAnalysis(candidate, sourceRecord, { baseAnalysisById, deferGrammarValidation }) {
  const id = sourceRecord.id;
  const sentenceText = plainSentence(sourceRecord.text);
  const repairedCandidate = Array.isArray(candidate?.grammar?.points)
    ? {
        ...candidate,
        grammar: {
          ...candidate.grammar,
          points: candidate.grammar.points.map(point => ({
            ...point,
            excerpt: recoverExactGrammarExcerpt(sentenceText, point?.excerpt),
          })),
        },
      }
    : candidate;
  const analysis = normalizeDetailedSentenceAnalysis(
    repairedCandidate,
    preservedGrammarFor(baseAnalysisById, sourceRecord),
    id,
  );
  if (!/^(?:yes|no)\b/i.test(analysis.americanEnglish.explanation.trim())) {
    throw new Error(`${id}: American English explanation must begin with Yes or No`);
  }
  if ([
    analysis.translation,
    analysis.americanEnglish.explanation,
    ...analysis.americanEnglish.evidence,
    analysis.pronunciation.slowIpa,
    analysis.pronunciation.fastIpa,
    analysis.pronunciation.carefulSpeakerGuide,
    ...analysis.pronunciation.fastSpeechFeatures,
    analysis.pronunciation.intonationAndChunking,
    analysis.pronunciation.keyDifference,
    analysis.imagePrompt,
  ]
    .some(leakedPlaceholder)) {
    throw new Error(`${id}: placeholder or schema field leaked into sentence analysis`);
  }
  if (leakedPlaceholder(analysis.grammar.structure)) {
    throw new Error(`${id}: placeholder leaked into grammar structure`);
  }
  if (!deferGrammarValidation) {
    const seenGrammarPoints = new Set();
    for (const point of analysis.grammar.points) {
      if (!point || !validString(point.label) || !validString(point.excerpt) ||
          !validString(point.explanation) ||
          [point.label, point.excerpt, point.explanation].some(leakedPlaceholder)) {
        throw new Error(`${id}: invalid grammar point`);
      }
      if (!sentenceGrammarExcerptMatchesText(sentenceText, point.excerpt)) {
        throw new Error(
          `${id}: grammar excerpt ${JSON.stringify(point.excerpt)} is not an exact quote from ` +
          `${JSON.stringify(sentenceText)}; preserve even awkward source wording and punctuation`,
        );
      }
      const pointKey = `${normalizedValue(point.label)}\0${point.excerpt}`;
      if (seenGrammarPoints.has(pointKey)) throw new Error(`${id}: duplicate grammar point`);
      seenGrammarPoints.add(pointKey);
    }
  }
  const seenTerms = new Set();
  for (const term of analysis.terms) {
    if (!validString(term.term) || !validString(term.chinese) || !validString(term.ipa) ||
        !validTermIpa(term.ipa) ||
        !validString(term.originalMeaning) || !validString(term.historicalEvolution) ||
        !Array.isArray(term.synonyms) || term.synonyms.length === 0 ||
        !term.synonyms.every(validString) || !Array.isArray(term.antonyms) || !term.antonyms.every(validString) ||
        !Array.isArray(term.examples) || term.examples.length < 2 || !term.examples.every(validString)) {
      throw new Error(`${id}: invalid term analysis`);
    }
    const termKey = normalizedValue(term.term);
    if (seenTerms.has(termKey)) throw new Error(`${id}: duplicate term ${term.term}`);
    seenTerms.add(termKey);
    if ([term.term, term.chinese, term.ipa, term.originalMeaning, term.historicalEvolution,
      ...term.synonyms, ...term.antonyms, ...term.examples].some(leakedPlaceholder)) {
      throw new Error(`${id}: placeholder or schema field leaked into term ${term.term}`);
    }
    const exampleKeys = term.examples.map(normalizedValue);
    if (new Set(exampleKeys).size !== exampleKeys.length) {
      throw new Error(`${id}: duplicate example for term ${term.term}`);
    }
  }
  return analysis;
}

// One batch's answer, checked: a { sourceRecord, analysis } pair for every sentence, or an error naming the
// problem. options are validateAnalysis's.
export function readAnalysisResults(parsed, batch, options) {
  const byIndex = indexedResults(parsed, batch.length, {
    wrongCount: 'Wrong analysis result count',
    duplicate: 'Duplicate sentence indexes',
  });
  return batch.map((sourceRecord, itemIndex) => {
    const result = byIndex.get(itemIndex);
    if (!result) throw new Error(`Missing sentence index ${itemIndex}`);
    return { sourceRecord, analysis: validateAnalysis(result.analysis, sourceRecord, options) };
  });
}
