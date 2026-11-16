// How a query is routed, decided once for both sides: the search box scans a sentence for its expressions
// first, and the analysis route picks the word or sentence instructions. The comparison size limit that the
// client and /api/compare both enforce lives here too. Like everything in server/src/shared it imports
// nothing (see README.md), and the client and the server both import it directly.

/** The most words one comparison accepts. The prompt keys every per-word map by word, so the output grows with each. */
export const MAX_COMPARE_WORDS = 8;

const AUX = 'am|is|are|was|were|be|been|have|has|had|do|does|did|will|would|shall|should|can|could|may|might|must';
// Simple past forms that are never attributive participles ("a well kept secret", "a chain saw" stay phrases).
const IRREGULAR_PAST = 'went|came|took|gave|knew|ran|ate|drank|drove|flew|grew|threw|wrote|spoke|began|forgot|became|sat|stood|got|broke';
const SUBJ = "(?:i|you|he|she|it|we|they)(?:'(?:m|re|s|ve|ll|d))?";
const RE_SUBJ_START = new RegExp(`^${SUBJ}\\s`);
const RE_EXISTENTIAL = new RegExp(`^(?:there|here|this|that|what|who|where|when|why|how)\\s+(?:${AUX})\\b`);
const RE_QUESTION = new RegExp(`^(?:${AUX})(?:n't)?\\s+${SUBJ}\\s+\\S`);
// A regular past tense ends in -ed, but so do participles used as adjectives after a degree adverb ("a much needed
// break", "a so called expert") and some nouns and adjectives ("the river bed", "the bright red car"). A few -ed
// verbs are nouns too: a noun at the end of the input ("a garden shed", "a basic need"), a verb before more words
// ("the snake shed its skin", "the kids need help"). Explicit lists, not "any -ly word": a wildcard would turn
// "my family moved away" into a phrase.
const PARTICIPLE_ADVERBS = 'well|ill|much|long|so|half|hard|highly|newly|widely|badly|poorly|fully|freshly|recently|deeply|' +
  'heavily|finely|richly|densely|tightly|lightly|perfectly|carefully|beautifully|largely|mostly|partly|over|under|best|' +
  'most|least|greatly|nicely';
const ED_NON_VERBS = 'bed|red|deed|reed|seed|weed|steed|creed|greed|tweed|sled|hundred|sacred|naked|wicked|kindred';
const ED_VERB_NOUNS = 'shed|need|feed|speed|breed|bleed';
const ED_VERB = `(?!(?:${ED_NON_VERBS})\\b)(?!(?:${ED_VERB_NOUNS})$)\\S+ed`;
const VERB = `(?:${AUX}|${IRREGULAR_PAST}|${ED_VERB})`;
// The verb right after a one-word subject: "the kids ran home", "the team agreed". "Well" is also a noun, so an -ed
// word ending the input after it is the verb: "the well collapsed" is a sentence, and so, wrongly, is "the well
// dressed".
const VERB_AFTER_WORD =
  `\\S+\\s+(?:${AUX}|${IRREGULAR_PAST})|(?!(?:${PARTICIPLE_ADVERBS})\\s)\\S+\\s+${ED_VERB}|well\\s+${ED_VERB}$`;
// Such a participle or -ed word belongs to the subject, and the verb comes after the rest of it: "the newly elected
// mayor resigned", "the flower bed was ruined", "the bright red car crashed". A participle always has a noun after it,
// one or two words ("a freshly opened can" stays a phrase); an -ed noun may end the subject itself. A conjunction joins
// two modifiers instead ("a highly skilled and dedicated worker" stays a phrase).
const NOUN_WORD = '(?!(?:and|or|but|nor)\\s)\\S+';
const VERB_AFTER_NOUN = `(?:${PARTICIPLE_ADVERBS})\\s+\\S+ed(?:\\s+${NOUN_WORD}){1,2}\\s+${VERB}|` +
  `\\S+\\s+(?:${ED_NON_VERBS})(?:\\s+${NOUN_WORD}){0,2}\\s+${VERB}`;
const RE_DET_SUBJ_VERB = new RegExp(
  `^(?:the|a|an|my|your|his|her|our|their|this|that)\\s+(?:${VERB_AFTER_WORD}|${VERB_AFTER_NOUN})\\b`,
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
