// Word family entry - related words of different parts of speech
export interface WordFamilyEntry {
  word: string;
  pos: string; // Part of speech: noun, verb, adj, adv, etc.
  chinese: string;
}

export type UsageStatus =
  | 'modern_american'
  | 'current_general'
  | 'british_only'
  | 'rare_or_dated'
  | 'narrow_specialized';

/** Offline audit of whether a specific sense is worth studying for modern American English. */
export interface UsageAudit {
  status: UsageStatus;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  auditedAt: number;
  /** Retains the pre-audit wording when an example or saved sentence was replaced. */
  originalText?: string;
}

export interface VocabCard {
  id: string; // Unique ID
  word: string;
  sense?: string; // Brief label for this specific meaning (e.g., "noun: emotion", "verb: to affect")
  chinese: string;
  ipa: string;
  definition: string;
  forms?: string[]; // Different forms of the word (e.g., run → runs, running, ran)
  wordFamily?: WordFamilyEntry[]; // Related words of different parts of speech
  synonyms: string[];
  antonyms: string[];
  confusables: string[]; // Words easily confused with this word (similar spelling, sound, or meaning)
  examples: string[];
  history: string;
  register: string;
  mnemonic: string;
  imagePrompt?: string; // To generate specific imagery
  imageUrl?: string; // Generated Base64 image
  usageAudit?: UsageAudit;
}

export interface SearchResult {
  id: string;
  query: string;
  translation: string;
  grammar: string; // Markdown
  visualKeyword: string;
  pronunciation: string;
  vocabs: VocabCard[];
  timestamp: number;
  imageUrl?: string; // Base64 data uri
  imagePrompt?: string; // Photorealistic prompt for the complete phrase
  originalQuery?: string; // Original Chinese input if translated
  usageAudit?: UsageAudit;
}

export type AmericanEnglishStatus = 'american' | 'shared' | 'not_american';

export interface SentenceAnalysisTerm {
  term: string;
  chinese: string;
  ipa: string;
  originalMeaning: string;
  synonyms: string[];
  antonyms: string[];
  examples: string[];
  historicalEvolution: string;
}

export interface SentenceGrammarPoint {
  label: string;
  excerpt: string;
  explanation: string;
}

export interface SentenceGrammarAnalysis {
  /** Compact map of the sentence's clause and phrase structure. */
  structure: string;
  /** Context-specific explanations of the grammar that carries meaning in this sentence. */
  points: SentenceGrammarPoint[];
}

export interface SentencePronunciationGuide {
  /** Deliberate but natural General American pronunciation with clear word boundaries. */
  slowIpa: string;
  /** Fluent connected-speech General American pronunciation. */
  fastIpa: string;
  /** Learner-friendly stress and chunk guide, not a replacement for IPA. */
  carefulSpeakerGuide: string;
  /** Sentence-specific linking, reduction, flapping, assimilation, or weak-form notes. */
  fastSpeechFeatures: string[];
  /** Suggested thought groups and pitch movement for the complete sentence. */
  intonationAndChunking: string;
  /** Plain-English contrast between the careful and fluent renderings. */
  keyDifference: string;
}

export interface SentenceAnalysis {
  translation: string;
  /** Legacy alias of pronunciation.fastIpa, retained while older records are migrated. */
  naturalSpeechIpa?: string;
  /** Optional during the legacy-data migration; required for newly generated analyses. */
  grammar?: SentenceGrammarAnalysis;
  americanEnglish: {
    status: AmericanEnglishStatus;
    explanation: string;
    /** Concrete sentence-specific reasons supporting the status. */
    evidence?: string[];
  };
  terms: SentenceAnalysisTerm[];
  /** Optional for legacy records; required for newly generated analyses. */
  pronunciation?: SentencePronunciationGuide;
  /** Photorealistic, text-free landscape prompt depicting the complete sentence. */
  imagePrompt: string;
}

// Sentence — saved example sentence from a vocabulary card
export interface SentenceData {
  id: string;
  text: string; // The sentence text. Markup: {{studied item}} (emphasis) and [[uncommon term]] (clickable lookup)
  sourceWord: string; // The vocab word this sentence came from
  sourceSense?: string; // The sense label of the source word
  imageUrl?: string; // Optional user-attached image (base64 data URI in memory; 'idb:stored'/'server:has_image' marker once offloaded)
  analysis?: SentenceAnalysis;
  analysisGeneratedAt?: number;
  usageAudit?: UsageAudit;
}

// SRS Data — FSRS v6 with optional fields for lazily migrated legacy rows
export interface SRSData {
  id: string; // References SearchResult.id or VocabCard.id
  type: 'vocab' | 'phrase' | 'sentence';
  nextReview: number; // Timestamp
  interval: number; // In minutes
  
  // Display-only mastery score derived from stability
  memoryStrength: number; // 0-100, derived from stability via log mapping
  lastReviewDate: number; // Timestamp of last review
  totalReviews: number; // Total scheduler repetitions, including Again ratings
  correctStreak: number; // Consecutive non-Again ratings
  
  // Core scheduling parameter
  stability: number; // FSRS memory stability in days

  // FSRS v6 state. Optional for legacy fixed-schedule rows and populated lazily on review.
  scheduler?: 'fsrs-v6';
  difficulty?: number;
  lapses?: number;
  fsrsState?: number;
  learningSteps?: number;
  scheduledDays?: number;
}

// Combined type for storage
export interface StoredItem {
  data: SearchResult | VocabCard | SentenceData;
  type: 'vocab' | 'phrase' | 'sentence';
  srs: SRSData;
  savedAt: number;
  updatedAt?: number;
  isDeleted?: boolean; // Soft delete flag for sync
  isArchived?: boolean; // Archive flag - keeps item but excludes from study
  project?: string; // Legacy-only migration field; current clients and server strip it.
  lastSyncedHash?: string; // Local-only hash of the content last accepted by the server
  serverRevision?: number; // Server-issued monotonic content revision for conflict ordering
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';
export type ReviewTaskType = 'meaning' | 'production' | 'cloze' | 'listening' | 'quick';

export interface ReviewEvent {
  id: string;
  itemId: string;
  itemType: 'vocab' | 'phrase' | 'sentence';
  reviewedAt: number;
  previousStep: number;
  nextStep: number;
  rating?: ReviewRating;
  taskType?: ReviewTaskType;
  durationMs?: number;
  sessionId?: string;
}

// Group type for items with same spelling - Shared across views
export interface ItemGroup {
  title: string;
  items: StoredItem[];
}

export type SyncStatus = 'idle' | 'syncing' | 'saved' | 'error';

export type ViewState = 'notebook' | 'study' | 'sentences';

// In-memory library state; durable mutation journals live in the storage/sync services.
export interface SyncState {
  items: StoredItem[];
}

/**
 * Type guard to check if a StoredItem contains vocabulary data.
 * When true, narrows the type to allow direct access to VocabCard properties.
 */
export const isVocabItem = (item: StoredItem): item is StoredItem & { type: 'vocab'; data: VocabCard } => 
  item.type === 'vocab';

/**
 * Type guard to check if a StoredItem contains phrase/sentence data.
 * When true, narrows the type to allow direct access to SearchResult properties.
 */
export const isPhraseItem = (item: StoredItem): item is StoredItem & { type: 'phrase'; data: SearchResult } =>
  item.type === 'phrase';

/**
 * Type guard to check if a StoredItem contains sentence data.
 */
export const isSentenceItem = (item: StoredItem): item is StoredItem & { type: 'sentence'; data: SentenceData } =>
  item.type === 'sentence';

/**
 * Gets the display title of a stored item (word for vocab, query for phrase, text for sentence).
 * @param item - The stored item to get the title from
 * @returns The word or query string, or empty string if not available
 */
export const getItemTitle = (item: StoredItem): string => {
  if (!item || !item.data) return '';
  if (isPhraseItem(item)) {
    return item.data.query || '';
  }
  if (isSentenceItem(item)) {
    return (item.data as SentenceData).text || '';
  }
  return (item.data as VocabCard).word || '';
};

/**
 * Gets the normalized spelling of an item (lowercase, trimmed title).
 * Useful for case-insensitive comparisons and grouping items by word.
 * @param item - The stored item
 * @returns Lowercase, trimmed title string
 */
export const getItemSpelling = (item: StoredItem): string => {
  return getItemTitle(item).toLowerCase().trim();
};

/**
 * Gets the sense/meaning label of a vocab item.
 * Returns empty string for phrase items or if sense is not defined.
 * @param item - The stored item
 * @returns Sense string (e.g., "noun: emotion") or empty string
 */
export const getItemSense = (item: StoredItem): string => {
  if (!item || !item.data || !isVocabItem(item)) return '';
  return item.data.sense || '';
};

/**
 * Gets the image URL of a stored item (base64 data URI).
 * @param item - The stored item
 * @returns Base64 image data URI or undefined if no image
 */
export const getItemImageUrl = (item: StoredItem): string | undefined => {
  if (!item || !item.data) return undefined;
  return item.data.imageUrl;
};

// Word Comparison — AI-generated side-by-side analysis of 2-3 similar words
interface ComparisonDimension {
  label: string;
  analysis: string;
  perWord: Record<string, string>;
}

interface ComparisonExample {
  context: string;
  sentences: Record<string, string>;
}

export interface ComparisonResult {
  words: string[];
  summary: string;
  dimensions: ComparisonDimension[];
  examples: ComparisonExample[];
  commonMistakes: string[];
  verdict: string;
}

// A persisted comparison (server + local), keyed by the normalized word-set so direction doesn't
// matter and it surfaces on every involved word's page.
export interface StoredComparison {
  key: string;        // e.g. 'fable|parable'
  words: string[];    // the words as compared (original order/casing for display)
  data: ComparisonResult;
  updatedAt: number;
}

/** Normalized key for a comparison: words lowercased, trimmed, de-duped, sorted, joined with '|'. */
export const comparisonKey = (words: string[]): string =>
  Array.from(new Set(words.map((w) => w.toLowerCase().trim()).filter(Boolean))).sort().join('|');

// Authenticated application user exposed to UI components
export interface AppUser {
  uid: string;
  displayName?: string | null;
  photoURL?: string | null;
  email?: string | null;
}
