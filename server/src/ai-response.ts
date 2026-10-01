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
      if (entry && typeof entry === 'object' && typeof (entry as any).sentence === 'string') {
        return (entry as any).sentence.trim();
      }
      return '';
    })
    .filter(Boolean);
};

const exampleIdentity = (value: string): string => value
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

function normalizeExamples(value: unknown): string[] {
  const seen = new Set<string>();
  return stringArray(value).filter(example => {
    const identity = exampleIdentity(example);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, 2);
}

export function isValidGeneratedExample(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length < 20 || value.length > 1_000) return false;
  const targets = [...value.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (targets.length !== 1 || !targets[0][1].trim() || /\[\[|\]\]/.test(targets[0][1])) return false;
  const lookups = [...value.matchAll(/\[\[([^\[\]]+)\]\]/g)];
  if (lookups.length > 4 || lookups.some(match => !match[1].trim())) return false;
  const remainder = value.replace(/\{\{[^{}]+\}\}/g, '').replace(/\[\[[^\[\]]+\]\]/g, '');
  return !/[{}\[\]]/.test(remainder);
}

export function isValidGeneratedExampleSet(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every(isValidGeneratedExample) &&
    new Set(value.map(exampleIdentity)).size === 2;
}

/** Why an example fails isValidGeneratedExample, in words the model can act on. Empty when it passes. */
export function exampleIssues(value: unknown): string[] {
  if (typeof value !== 'string') return ['must be a string'];
  const issues: string[] = [];
  if (value.trim().length < 20) issues.push('must be at least 20 characters');
  if (value.length > 1_000) issues.push('must be at most 1000 characters');
  const targets = [...value.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (targets.length !== 1) {
    issues.push(`must wrap the studied word in {{double curly braces}} exactly once (found ${targets.length})`);
  } else if (!targets[0][1].trim() || /\[\[|\]\]/.test(targets[0][1])) {
    issues.push('the {{target}} must be plain, non-empty text');
  }
  const lookups = [...value.matchAll(/\[\[([^\[\]]+)\]\]/g)];
  if (lookups.length > 4) issues.push(`must have at most 4 [[lookup]] markers (found ${lookups.length})`);
  if (lookups.some(match => !match[1].trim())) issues.push('[[lookup]] markers must not be empty');
  const remainder = value.replace(/\{\{[^{}]+\}\}/g, '').replace(/\[\[[^\[\]]+\]\]/g, '');
  if (/[{}\[\]]/.test(remainder)) issues.push('must not contain stray { } [ ] characters outside the markers');
  return issues;
}

/** Why an example set fails isValidGeneratedExampleSet, one reason per problem. */
export function exampleSetIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return ['"examples" must be an array of exactly 2 sentences'];
  const issues: string[] = [];
  if (value.length !== 2) issues.push(`"examples" must contain exactly 2 sentences (found ${value.length})`);
  value.slice(0, 2).forEach((example, index) => {
    for (const issue of exampleIssues(example)) issues.push(`example ${index + 1} ${issue}`);
  });
  if (value.length === 2 && value.every(example => typeof example === 'string') &&
      new Set(value.map(exampleIdentity)).size < 2) {
    issues.push('the two examples must be different sentences');
  }
  return issues;
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
  const vocab = value as any;
  const issues: string[] = [];
  for (const [field, minimum] of FIELD_MINIMUMS) {
    if (field === 'register' && options.optionalRegister && vocab.register === '') continue;
    if (typeof vocab[field] !== 'string' || vocab[field].trim().length < minimum) {
      issues.push(`"${field}" must be a string of at least ${minimum} characters`);
    }
  }
  if (typeof vocab.chinese === 'string' && vocab.chinese.trim() && !/[\u3400-\u9fff]/u.test(vocab.chinese)) {
    issues.push('"chinese" must contain Chinese characters');
  }
  if (typeof vocab.ipa !== 'string' || !/^\/[^/]+\/$/.test(vocab.ipa.trim())) {
    issues.push('"ipa" must be exactly one American IPA transcription wrapped in slashes, like /ˈbæŋk/');
  }
  for (const field of ['forms', 'synonyms', 'antonyms', 'confusables'] as const) {
    if (!Array.isArray(vocab[field]) || !vocab[field].every((entry: unknown) =>
      typeof entry === 'string' && entry.trim().length > 0)) {
      issues.push(`"${field}" must be an array of non-empty strings`);
    }
  }
  if (!Array.isArray(vocab.wordFamily) || !vocab.wordFamily.every((entry: any) =>
    entry && typeof entry.word === 'string' && entry.word.trim() &&
    typeof entry.pos === 'string' && entry.pos.trim() &&
    typeof entry.chinese === 'string' && /[\u3400-\u9fff]/u.test(entry.chinese))) {
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
  if (value && typeof value === 'object' && !Array.isArray(value)) issues.push(...exampleSetIssues((value as any).examples));
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
  const rawObject: any = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
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
  const confidence = ['high', 'medium', 'low'].includes(rawObject.confidence)
    ? rawObject.confidence as NormalizedUsageAudit['confidence']
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

function normalizeWordFamily(value: unknown): Array<{ word: string; pos: string; chinese: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const word = stringValue((entry as any).word);
    if (!word) return [];
    return [{
      word,
      pos: stringValue((entry as any).pos ?? (entry as any).partOfSpeech),
      chinese: stringValue((entry as any).chinese ?? (entry as any).translation),
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
    const bracketed = trimmed.match(/^\[([^\[\]]+)\]$/);
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

/**
 * Fix the example markup slips the model makes most often, before validation: a lookup nested in the
 * target, stray brackets, two targets (the one that is not the headword becomes a lookup), no target
 * (a lookup naming the headword is promoted, else the headword or a listed form is marked), and more
 * than four lookups (the extras are unwrapped). Wording is never changed.
 */
export function repairGeneratedExample(example: string, word: string, forms: string[] = []): string {
  let s = example.trim().replace(/\{\{([^{}]*)\}\}/g, (_match, inner: string) => `{{${inner.replace(/\[\[|\]\]/g, '')}}}`);

  // Keep well-formed markers, drop empty ones, and strip every other brace or bracket.
  const markers: string[] = [];
  s = s.replace(/\{\{([^{}\[\]]*)\}\}|\[\[([^\[\]{}]*)\]\]/g, (match, target?: string, lookup?: string) => {
    const inner = target ?? lookup ?? '';
    return inner.trim() ? `\u0000${markers.push(match) - 1}\u0000` : inner;
  });
  s = s.replace(/[{}\[\]]/g, '').replace(MARKER_SLOT, (_match, index: string) => markers[Number(index)]);

  const candidates = [word, ...forms].map(form => form.trim()).filter(Boolean);
  const lowerCandidates = candidates.map(form => form.toLowerCase());
  const namesHeadword = (text: string) => {
    const lower = text.trim().toLowerCase();
    return lowerCandidates.some(form => lower === form || lower.includes(form) || form.includes(lower));
  };
  const targets = [...s.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (targets.length > 1) {
    const keep = Math.max(0, targets.findIndex(target => namesHeadword(target[1])));
    let index = -1;
    s = s.replace(/\{\{([^{}]+)\}\}/g, (_match, inner: string) => (++index === keep ? `{{${inner}}}` : `[[${inner}]]`));
  } else if (targets.length === 0) {
    let promoted = false;
    s = s.replace(/\[\[([^\[\]]+)\]\]/g, (match, inner: string) => {
      if (promoted || !lowerCandidates.includes(inner.trim().toLowerCase())) return match;
      promoted = true;
      return `{{${inner}}}`;
    });
    if (!promoted) {
      // Mark the first plain-text occurrence of the longest candidate; lookups are masked so none is matched inside one.
      const lookups: string[] = [];
      let masked = s.replace(/\[\[[^\[\]]+\]\]/g, match => `\u0000${lookups.push(match) - 1}\u0000`);
      for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(${escapeRegExp(candidate).replace(/\s+/g, '\\s+')})(?![\\p{L}\\p{N}_])`, 'iu');
        if (pattern.test(masked)) {
          masked = masked.replace(pattern, '{{$1}}');
          break;
        }
      }
      s = masked.replace(MARKER_SLOT, (_match, index: string) => lookups[Number(index)]);
    }
  }

  let lookupCount = 0;
  s = s.replace(/\[\[([^\[\]]+)\]\]/g, (match, inner: string) => (++lookupCount <= 4 ? match : inner));
  return s.replace(/[ \t]{2,}/g, ' ');
}

// Only the fields the card schema defines are kept: a stray model key must not be stored on the card
// or spoof a pipeline marker such as advancedEnrichment.
export function normalizeVocabCard(raw: unknown, fallbackWord: string, auditedAt: number): any | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as any;
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
  const audit = value as any;
  return USAGE_STATUSES.has(audit.status) &&
    typeof audit.reason === 'string' && audit.reason.length > 0 &&
    ['high', 'medium', 'low'].includes(audit.confidence) &&
    Number.isFinite(audit.auditedAt) && audit.auditedAt > 0;
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
  options: { fallbackQuery: string; auditedAt?: number },
): { data: any; inputCards: number; droppedCards: number } {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as any : {};
  const auditedAt = options.auditedAt ?? Date.now();
  const query = stringValue(source.query, options.fallbackQuery);
  const possibleCards = source.vocabs ?? source.vocabularyCards ?? source.vocabulary_cards ?? source.cards ?? source.meanings;
  const rawVocabs = Array.isArray(possibleCards)
    ? possibleCards
    : source.vocab && typeof source.vocab === 'object'
      ? [source.vocab]
      : [];
  const vocabs: any[] = sortVocabsByUsage<any>(
    rawVocabs.flatMap((vocab: unknown) => {
      const normalized = normalizeVocabCard(vocab, query || options.fallbackQuery, auditedAt);
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
