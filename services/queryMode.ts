// Query routing shared by the search box and the server's analysis route.
// MIRRORED in server/src/query-mode.ts (the server compiles only its own src/, so it keeps a copy).
// KEEP BOTH COPIES IDENTICAL: server/test/query-mode.test.ts runs the same inputs through each.

/** The most words one comparison accepts. The prompt keys every per-word map by word, so the output grows with each. */
export const MAX_COMPARE_WORDS = 8;

const AUX = 'am|is|are|was|were|be|been|have|has|had|do|does|did|will|would|shall|should|can|could|may|might|must';
// Simple past forms that are never attributive participles ("a well kept secret", "a chain saw" stay phrases).
const IRREGULAR_PAST = 'went|came|took|gave|knew|ran|ate|drank|drove|flew|grew|threw|wrote|spoke|began|forgot|became|sat|stood|got|broke';
const SUBJ = "(?:i|you|he|she|it|we|they)(?:'(?:m|re|s|ve|ll|d))?";
const RE_SUBJ_START = new RegExp(`^${SUBJ}\\s`);
const RE_EXISTENTIAL = new RegExp(`^(?:there|here|this|that|what|who|where|when|why|how)\\s+(?:${AUX})\\b`);
const RE_QUESTION = new RegExp(`^(?:${AUX})(?:n't)?\\s+${SUBJ}\\s+\\S`);
const RE_DET_SUBJ_VERB = new RegExp(
  `^(?:the|a|an|my|your|his|her|our|their|this|that)\\s+\\S+\\s+(?:${AUX}|${IRREGULAR_PAST}|\\S+ed)\\b`,
);

/**
 * True when the input is a word, phrase or idiom (analyzed as one dictionary entry) rather than a sentence.
 * Idioms full of auxiliaries and determiners ("might as well", "the elephant in the room") stay lexical;
 * a subject followed by a verb, a question, or closing punctuation on four or more words marks a sentence.
 */
export function isWordOrPhrase(text: string): boolean {
  const trimmed = text.trim();
  const han = trimmed.match(/[一-鿿]/g) || [];
  if (han.length) return han.length < 8 && !/[，,。！？].+/.test(trimmed);
  const core = trimmed.replace(/[.!?…]+["')\]]*$/, '');
  const words = core.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return true;
  if (words.length >= 7) return false;
  if (core !== trimmed && words.length >= 4) return false;
  const lower = core.toLowerCase().replace(/’/g, "'");
  if (RE_SUBJ_START.test(lower)) return false;
  if (RE_EXISTENTIAL.test(lower)) return false;
  if (RE_QUESTION.test(lower)) return false;
  if (RE_DET_SUBJ_VERB.test(lower)) return false;
  return true;
}

/** The search box's side of the same decision: a sentence is scanned for its expressions first. */
export function looksLikeSentence(text: string): boolean {
  return text.trim().length > 0 && !isWordOrPhrase(text);
}
