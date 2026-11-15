import { exampleIdentity, exampleSetIssues } from './example-rules.js';

// The example rules live in an import-free module the offline scripts can load under plain node.
export {
  exampleIdentity,
  exampleIssues,
  exampleSetIssues,
  isValidGeneratedExample,
  isValidGeneratedExampleSet,
} from './example-rules.js';

export type UsageStatus =
  | 'modern_american'
  | 'current_general'
  | 'british_only'
  | 'rare_or_dated'
  | 'narrow_specialized';

export interface NormalizedUsageAudit {
  status: UsageStatus;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  auditedAt: number;
}

export interface WordFamilyEntry {
  word: string;
  pos: string;
  chinese: string;
}

/** A vocab card as normalization builds it: exactly the schema's fields, each one present. */
export interface GeneratedVocabCard {
  word: string;
  sense: string;
  chinese: string;
  ipa: string;
  definition: string;
  forms: string[];
  wordFamily: WordFamilyEntry[];
  synonyms: string[];
  antonyms: string[];
  confusables: string[];
  examples: string[];
  history: string;
  register: string;
  mnemonic: string;
  imagePrompt: string;
  usageAudit: NormalizedUsageAudit;
}

/** A normalized analysis answer: the sentence-level fields (empty for a word) and the cards. */
export interface AnalysisData {
  query: string;
  translation: string;
  grammar: string;
  visualKeyword: string;
  pronunciation: string;
  vocabs: GeneratedVocabCard[];
}

type JsonObject = Record<string, unknown>;

const isConfidence = (value: unknown): value is NormalizedUsageAudit['confidence'] =>
  value === 'high' || value === 'medium' || value === 'low';

const USAGE_STATUSES = new Set<UsageStatus>([
  'modern_american',
  'current_general',
  'british_only',
  'rare_or_dated',
  'narrow_specialized',
]);

const USAGE_ORDER: Record<UsageStatus, number> = {
  modern_american: 0,
  current_general: 1,
  narrow_specialized: 2,
  british_only: 3,
  rare_or_dated: 4,
};

const stringValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value.trim() : fallback;

const stringArray = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values
    .map(entry => {
      if (typeof entry === 'string') return entry.trim();
      const sentence = entry && typeof entry === 'object' ? (entry as JsonObject).sentence : undefined;
      if (typeof sentence === 'string') return sentence.trim();
      return '';
    })
    .filter(Boolean);
};

function normalizeExamples(value: unknown): string[] {
  const seen = new Set<string>();
  return stringArray(value).filter(example => {
    const identity = exampleIdentity(example);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, 2);
}

export interface VocabValidationOptions {
  /** Live analysis accepts a card without a register note; stored-corpus checks require one. */
  optionalRegister?: boolean;
}

/**
 * The shortest register note a card keeps, the same as scripts/offline/vocab-card-contract.mjs requires of
 * the stored corpus. Normalization drops a shorter label ("formal"), and the local cycle writes a full note.
 */
export const REGISTER_MINIMUM = 10;

const FIELD_MINIMUMS = [
  ['word', 1], ['sense', 3], ['chinese', 1], ['definition', 10], ['history', 20],
  ['register', REGISTER_MINIMUM], ['mnemonic', 10], ['imagePrompt', 50],
] as const;

function metadataIssues(value: unknown, options: VocabValidationOptions): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['the card must be a JSON object'];
  const vocab = value as JsonObject;
  const issues: string[] = [];
  for (const [field, minimum] of FIELD_MINIMUMS) {
    const text = vocab[field];
    if (field === 'register' && options.optionalRegister && text === '') continue;
    if (typeof text !== 'string' || text.trim().length < minimum) {
      issues.push(`"${field}" must be a string of at least ${minimum} characters`);
    }
  }
  if (typeof vocab.chinese === 'string' && vocab.chinese.trim() && !/[\u3400-\u9fff]/u.test(vocab.chinese)) {
    issues.push('"chinese" must contain Chinese characters');
  }
  // One line, as the offline vocab contract also requires.
  if (typeof vocab.ipa !== 'string' || !/^\/[^/\n]+\/$/.test(vocab.ipa.trim())) {
    issues.push('"ipa" must be exactly one American IPA transcription wrapped in slashes, like /ˈbæŋk/');
  }
  for (const field of ['forms', 'synonyms', 'antonyms', 'confusables'] as const) {
    const list = vocab[field];
    if (!Array.isArray(list) || !list.every((entry: unknown) =>
      typeof entry === 'string' && entry.trim().length > 0)) {
      issues.push(`"${field}" must be an array of non-empty strings`);
    }
  }
  const family = vocab.wordFamily;
  if (!Array.isArray(family) || !family.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const { word, pos, chinese } = entry as JsonObject;
    return typeof word === 'string' && word.trim() && typeof pos === 'string' && pos.trim() &&
      typeof chinese === 'string' && /[\u3400-\u9fff]/u.test(chinese);
  })) {
    issues.push('every "wordFamily" entry must have "word", "pos" and a Chinese "chinese"');
  }
  if (!isValidUsageAudit(vocab.usageAudit)) issues.push('"usageAudit" must have a valid status, reason and confidence');
  return issues;
}

export function hasCompleteGeneratedVocabMetadata(value: unknown, options: VocabValidationOptions = {}): boolean {
  return metadataIssues(value, options).length === 0;
}

/** Every reason a generated card fails validation (metadata and examples). Empty when the card is usable. */
export function vocabValidationIssues(value: unknown, options: VocabValidationOptions = {}): string[] {
  const issues = metadataIssues(value, options);
  if (value && typeof value === 'object' && !Array.isArray(value)) issues.push(...exampleSetIssues((value as JsonObject).examples));
  return issues;
}

function parseUsageStatus(value: unknown): UsageStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (USAGE_STATUSES.has(normalized as UsageStatus)) return normalized as UsageStatus;
  if (/british|uk_only|chiefly_uk/.test(normalized)) return 'british_only';
  if (/rare|dated|archaic|obsolete|historical|literary/.test(normalized)) return 'rare_or_dated';
  if (/special|technical|jargon|domain|niche/.test(normalized)) return 'narrow_specialized';
  if (/american|us_only|chiefly_us/.test(normalized)) return 'modern_american';
  if (/current|general|common|mainstream|standard/.test(normalized)) return 'current_general';
  return null;
}

function inferUsageStatus(registerNote: string): UsageStatus {
  const register = registerNote.toLowerCase();
  if (/\b(british|chiefly uk|uk only)\b/.test(register)) return 'british_only';
  if (/\b(archaic|obsolete|dated|rare|historical|literary)\b/.test(register)) return 'rare_or_dated';
  if (/\b(specialized|specialist|technical|jargon|medicine|medical|legal|chemistry|geology)\b/.test(register)) {
    return 'narrow_specialized';
  }
  if (/\b(american|chiefly us|us only)\b/.test(register)) return 'modern_american';
  return 'current_general';
}

function normalizeUsageAudit(raw: unknown, register: string, auditedAt: number): NormalizedUsageAudit {
  const rawObject: JsonObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as JsonObject : {};
  const explicitStatus = parseUsageStatus(
    typeof raw === 'string' ? raw : rawObject.status ?? rawObject.label ?? rawObject.category,
  );
  const status = explicitStatus ?? inferUsageStatus(register);
  const suppliedReason = stringValue(rawObject.reason ?? rawObject.explanation ?? rawObject.note);
  const fallbackReason = explicitStatus
    ? `Classified as ${status.replaceAll('_', ' ')} for modern American English learners.`
    : register
      ? `Automatically classified from the register note: ${register}`
      : 'No usage classification was supplied; retained as current general English for review.';
  const confidence = isConfidence(rawObject.confidence)
    ? rawObject.confidence
    : explicitStatus
      ? 'medium'
      : 'low';
  return {
    status,
    reason: (suppliedReason || fallbackReason).slice(0, 1000),
    confidence,
    auditedAt,
  };
}

function normalizeWordFamily(value: unknown): WordFamilyEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const source = entry as JsonObject;
    const word = stringValue(source.word);
    if (!word) return [];
    return [{
      word,
      pos: stringValue(source.pos ?? source.partOfSpeech),
      chinese: stringValue(source.chinese ?? source.translation),
    }];
  });
}

const IPA_CHARACTER = /[ˈˌːəɚɝɪʊæɑɔɛʌθðŋʃʒɹɾ]/u;

/**
 * Reduce a generated pronunciation to the single /…/ transcription the validator requires. A
 * multi-word headword sometimes comes back as one slash group per word ("/rʌn/ /daʊn/"), which is
 * joined; alternates, region labels and second pronunciations after the first group are dropped.
 */
export function repairIpa(value: string, word: string): string {
  const trimmed = value.trim();
  const groups = [...trimmed.matchAll(/\/([^/]+)\//g)].map(match => match[1].trim()).filter(Boolean);
  if (groups.length === 0) {
    const bracketed = trimmed.match(/^\[([^[\]]+)\]$/);
    if (bracketed) return `/${bracketed[1].trim()}/`;
    return trimmed && !trimmed.includes('/') && IPA_CHARACTER.test(trimmed) ? `/${trimmed}/` : trimmed;
  }
  const wordCount = word.trim().split(/\s+/).filter(Boolean).length;
  if (groups.length > 1 && groups.length === wordCount && /^\/[^/]+\/(?:\s+\/[^/]+\/)+$/.test(trimmed)) {
    return `/${groups.join(' ')}/`;
  }
  return `/${groups[0]}/`;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER_SLOT = /\u0000(\d+)\u0000/g;

const wordsOf = (text: string): string[] => text.trim().toLowerCase().split(/\s+/).filter(Boolean);
// A candidate as whole words in a text (its words may be split by any whitespace); `wordEnd` false also matches it at
// the start of a longer word, as an inflection ('banks' for 'bank').
const candidatePattern = (candidate: string, wordEnd = true): RegExp => new RegExp(
  `(?<![\\p{L}\\p{N}_])(${escapeRegExp(candidate).replace(/\s+/g, '\\s+')})${wordEnd ? '(?![\\p{L}\\p{N}_])' : ''}`,
  'iu',
);

// A multi-word target the model split ('{{turned}} it {{down}}', '{{run}} {{down}}') becomes one target over the span,
// the form the prompt asks for ('{{turned it down}}'): consecutive targets made only of one multi-word candidate's
// words, naming all of them between them, at most three words more than the candidate apart and no lookup between.
function mergeSplitTarget(s: string, candidates: string[]): string {
  const targets = [...s.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (targets.length < 2) return s;
  for (const candidate of candidates) {
    const candidateWords = wordsOf(candidate);
    if (candidateWords.length < 2) continue;
    const within = (target: RegExpMatchArray) => wordsOf(target[1]).every(word => candidateWords.includes(word));
    for (let first = 0; first < targets.length;) {
      if (!within(targets[first])) {
        first++;
        continue;
      }
      let last = first;
      while (last + 1 < targets.length && within(targets[last + 1])) last++;
      const start = targets[first].index ?? 0;
      const end = (targets[last].index ?? 0) + targets[last][0].length;
      const span = s.slice(start, end);
      const plain = span.replace(/\{\{|\}\}/g, '');
      const named = new Set(targets.slice(first, last + 1).flatMap(target => wordsOf(target[1])));
      if (last > first && !span.includes('[[') && wordsOf(plain).length <= candidateWords.length + 3 &&
          candidateWords.every(word => named.has(word))) {
        return `${s.slice(0, start)}{{${plain}}}${s.slice(end)}`;
      }
      first = last + 1;
    }
  }
  return s;
}

// Which of several targets is the studied item: one equal to a candidate; else one holding a candidate as whole words;
// else one with a candidate starting a word (an inflection the forms don't list); else a whole word of three or more
// letters of a multi-word candidate ('down' of 'turn down'); else the first.
function chooseTarget(targets: string[], candidates: string[]): number {
  const lower = targets.map(target => target.trim().toLowerCase());
  const tiers: Array<(target: string) => boolean> = [
    target => candidates.includes(target),
    target => candidates.some(candidate => candidatePattern(candidate).test(target)),
    target => candidates.some(candidate => candidatePattern(candidate, false).test(target)),
    target => target.replace(/[^\p{L}]/gu, '').length >= 3 &&
      candidates.some(candidate => wordsOf(candidate).length > 1 && wordsOf(candidate).includes(target)),
  ];
  for (const tier of tiers) {
    const index = lower.findIndex(tier);
    if (index >= 0) return index;
  }
  return 0;
}

/**
 * Fix the example markup slips the model makes most often, before validation: a lookup nested in the
 * target, stray brackets, a phrase split over two targets (joined into one), two targets (the one that
 * is not the headword becomes a lookup), no target (a lookup naming the headword is promoted, else the
 * headword or a listed form is marked), and more than four lookups (the extras are unwrapped). Wording
 * is never changed.
 */
export function repairGeneratedExample(example: string, word: string, forms: string[] = []): string {
  let s = example.trim().replace(/\{\{([^{}]*)\}\}/g, (_match, inner: string) => `{{${inner.replace(/\[\[|\]\]/g, '')}}}`);

  // Keep well-formed markers, drop empty ones, and strip every other brace or bracket.
  const markers: string[] = [];
  s = s.replace(/\{\{([^{}[\]]*)\}\}|\[\[([^[\]{}]*)\]\]/g, (match, target?: string, lookup?: string) => {
    const inner = target ?? lookup ?? '';
    return inner.trim() ? `\u0000${markers.push(match) - 1}\u0000` : inner;
  });
  s = s.replace(/[{}[\]]/g, '').replace(MARKER_SLOT, (_match, index: string) => markers[Number(index)]);

  const candidates = [word, ...forms].map(form => form.trim()).filter(Boolean);
  const lowerCandidates = candidates.map(form => form.toLowerCase());
  s = mergeSplitTarget(s, lowerCandidates);
  const targets = [...s.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (targets.length > 1) {
    const keep = chooseTarget(targets.map(target => target[1]), lowerCandidates);
    let index = -1;
    s = s.replace(/\{\{([^{}]+)\}\}/g, (_match, inner: string) => (++index === keep ? `{{${inner}}}` : `[[${inner}]]`));
  } else if (targets.length === 0) {
    let promoted = false;
    s = s.replace(/\[\[([^[\]]+)\]\]/g, (match, inner: string) => {
      if (promoted || !lowerCandidates.includes(inner.trim().toLowerCase())) return match;
      promoted = true;
      return `{{${inner}}}`;
    });
    if (!promoted) {
      // Mark the first plain-text occurrence of the longest candidate; lookups are masked so none is matched inside one.
      const lookups: string[] = [];
      let masked = s.replace(/\[\[[^[\]]+\]\]/g, match => `\u0000${lookups.push(match) - 1}\u0000`);
      for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
        const pattern = candidatePattern(candidate);
        if (pattern.test(masked)) {
          masked = masked.replace(pattern, '{{$1}}');
          break;
        }
      }
      s = masked.replace(MARKER_SLOT, (_match, index: string) => lookups[Number(index)]);
    }
  }

  let lookupCount = 0;
  s = s.replace(/\[\[([^[\]]+)\]\]/g, (match, inner: string) => (++lookupCount <= 4 ? match : inner));
  return s.replace(/[ \t]{2,}/g, ' ');
}

// Only the fields the card schema defines are kept: a stray model key must not be stored on the card
// or spoof a pipeline marker such as advancedEnrichment.
export function normalizeVocabCard(raw: unknown, fallbackWord: string, auditedAt: number): GeneratedVocabCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as JsonObject;
  const word = stringValue(source.word ?? source.term ?? source.headword ?? source.phrase) || fallbackWord.trim();
  const definition = stringValue(
    source.definition ?? source.meaning ?? source.originalMeaning ?? source.original_meaning ?? source.gloss,
  );
  // A card without a headword or meaning is not useful. Drop just that card instead of rejecting its siblings.
  if (!word || !definition) return null;

  const forms = stringArray(source.forms);
  const registerNote = stringValue(source.register ?? source.usageNote);
  const register = registerNote.length >= REGISTER_MINIMUM ? registerNote : '';
  return {
    word,
    sense: stringValue(source.sense ?? source.senseLabel ?? source.partOfSpeech ?? source.part_of_speech, 'general meaning'),
    chinese: stringValue(source.chinese ?? source.translation ?? source.chineseTranslation ?? source.chinese_translation),
    ipa: repairIpa(stringValue(source.ipa ?? source.pronunciation), word),
    definition,
    forms,
    wordFamily: normalizeWordFamily(source.wordFamily ?? source.word_family),
    synonyms: stringArray(source.synonyms),
    antonyms: stringArray(source.antonyms),
    confusables: stringArray(source.confusables),
    examples: normalizeExamples(
      stringArray(source.examples ?? source.usageExamples).map(example => repairGeneratedExample(example, word, forms)),
    ),
    history: stringValue(source.history ?? source.etymology ?? source.historicalEvolution),
    register,
    mnemonic: stringValue(source.mnemonic ?? source.memoryAid),
    imagePrompt: stringValue(source.imagePrompt ?? source.image_prompt),
    usageAudit: normalizeUsageAudit(source.usageAudit ?? source.usage ?? source.usageLabel, registerNote, auditedAt),
  };
}

export function isValidUsageAudit(value: unknown): value is NormalizedUsageAudit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const audit = value as JsonObject;
  return USAGE_STATUSES.has(audit.status as UsageStatus) &&
    typeof audit.reason === 'string' && audit.reason.length > 0 &&
    isConfidence(audit.confidence) &&
    typeof audit.auditedAt === 'number' && Number.isFinite(audit.auditedAt) && audit.auditedAt > 0;
}

export function sortVocabsByUsage<T extends { usageAudit?: { status?: UsageStatus } }>(vocabs: T[]): T[] {
  return vocabs
    .map((vocab, index) => ({ vocab, index }))
    .sort((a, b) => {
      const aRank = a.vocab.usageAudit?.status ? USAGE_ORDER[a.vocab.usageAudit.status] : 99;
      const bRank = b.vocab.usageAudit?.status ? USAGE_ORDER[b.vocab.usageAudit.status] : 99;
      return aRank - bRank || a.index - b.index;
    })
    .map(entry => entry.vocab);
}

export function normalizeAnalysisResponse(
  raw: unknown,
  options: {
    fallbackQuery: string;
    /**
     * The query is one headword (word mode), so a card that comes back without its word is for the query. In a
     * sentence the query is the whole sentence, and such a card is dropped.
     */
    queryIsHeadword?: boolean;
    auditedAt?: number;
  },
): { data: AnalysisData; inputCards: number; droppedCards: number } {
  const source: JsonObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as JsonObject : {};
  const auditedAt = options.auditedAt ?? Date.now();
  const query = stringValue(source.query, options.fallbackQuery);
  const possibleCards = source.vocabs ?? source.vocabularyCards ?? source.vocabulary_cards ?? source.cards ?? source.meanings;
  const rawVocabs = Array.isArray(possibleCards)
    ? possibleCards
    : source.vocab && typeof source.vocab === 'object'
      ? [source.vocab]
      : [];
  const vocabs = sortVocabsByUsage(
    rawVocabs.flatMap((vocab: unknown) => {
      const normalized = normalizeVocabCard(vocab, options.queryIsHeadword ? query || options.fallbackQuery : '', auditedAt);
      return normalized ? [normalized] : [];
    }),
  );

  return {
    data: {
      query: query || options.fallbackQuery,
      translation: stringValue(source.translation),
      grammar: stringValue(source.grammar),
      visualKeyword: stringValue(source.visualKeyword, vocabs[0]?.word || query || options.fallbackQuery),
      pronunciation: stringValue(source.pronunciation, vocabs[0]?.ipa || ''),
      vocabs,
    },
    inputCards: rawVocabs.length,
    droppedCards: rawVocabs.length - vocabs.length,
  };
}
