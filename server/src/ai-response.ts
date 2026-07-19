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

function inferUsageStatus(vocab: any): UsageStatus {
  const register = stringValue(vocab?.register).toLowerCase();
  if (/\b(british|chiefly uk|uk only)\b/.test(register)) return 'british_only';
  if (/\b(archaic|obsolete|dated|rare|historical|literary)\b/.test(register)) return 'rare_or_dated';
  if (/\b(specialized|specialist|technical|jargon|medicine|medical|legal|chemistry|geology)\b/.test(register)) {
    return 'narrow_specialized';
  }
  if (/\b(american|chiefly us|us only)\b/.test(register)) return 'modern_american';
  return 'current_general';
}

function normalizeUsageAudit(vocab: any, auditedAt: number): NormalizedUsageAudit {
  const raw = vocab?.usageAudit ?? vocab?.usage ?? vocab?.usageLabel;
  const rawObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const explicitStatus = parseUsageStatus(
    typeof raw === 'string' ? raw : rawObject.status ?? rawObject.label ?? rawObject.category,
  );
  const status = explicitStatus ?? inferUsageStatus(vocab);
  const suppliedReason = stringValue(rawObject.reason ?? rawObject.explanation ?? rawObject.note);
  const register = stringValue(vocab?.register);
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

export function normalizeVocabCard(raw: unknown, fallbackWord: string, auditedAt: number): any | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as any;
  const word = stringValue(source.word ?? source.term ?? source.headword ?? source.phrase) || fallbackWord.trim();
  const definition = stringValue(
    source.definition ?? source.meaning ?? source.originalMeaning ?? source.original_meaning ?? source.gloss,
  );
  // A card without a headword or meaning is not useful. Drop just that card instead of rejecting its siblings.
  if (!word || !definition) return null;

  const normalized = {
    ...source,
    word,
    sense: stringValue(source.sense ?? source.senseLabel ?? source.partOfSpeech ?? source.part_of_speech, 'general meaning'),
    chinese: stringValue(source.chinese ?? source.translation ?? source.chineseTranslation ?? source.chinese_translation),
    ipa: stringValue(source.ipa ?? source.pronunciation),
    definition,
    forms: stringArray(source.forms),
    wordFamily: normalizeWordFamily(source.wordFamily ?? source.word_family),
    synonyms: stringArray(source.synonyms),
    antonyms: stringArray(source.antonyms),
    confusables: stringArray(source.confusables),
    examples: stringArray(source.examples ?? source.usageExamples),
    history: stringValue(source.history ?? source.etymology ?? source.historicalEvolution),
    register: stringValue(source.register ?? source.usageNote),
    mnemonic: stringValue(source.mnemonic ?? source.memoryAid),
    imagePrompt: stringValue(source.imagePrompt ?? source.image_prompt),
  };
  return { ...normalized, usageAudit: normalizeUsageAudit(normalized, auditedAt) };
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
      ...source,
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
