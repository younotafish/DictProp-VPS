// The usage audit, the detailed sentence analysis and the review vocabulary are the server's contracts: their types
// come from server/src through type-only imports and re-exports, so nothing of the server reaches the bundle.
import type { SentenceAnalysis } from './server/src/sentence-analysis';
import type { ReviewRating, ReviewTaskType } from './server/src/shared/review';
import type { UsageAudit } from './server/src/shared/usage-audit';

// Word family entry - related words of different parts of speech
export interface WordFamilyEntry {
  word: string;
  pos: string; // Part of speech: noun, verb, adj, adv, etc.
  chinese: string;
}

export type { UsageAudit, UsageStatus } from './server/src/shared/usage-audit';

/** Proves which offline enrichment harness generated this card's rich learning metadata. */
export interface AdvancedEnrichmentMarker {
  version: 1;
  provider: 'codex-harness' | 'claude-code' | 'local-mlx';
  model: string;
  generatedAt: number;
  contentHash: string;
}

export interface LocalImageEnrichmentMarker {
  version: 1;
  provider: 'local-ernie';
  model: string;
  generatedAt: number;
  promptHash: string;
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
  imageUrl?: string; // A picture marker ('idb:stored', 'server:has_image:<version>'), or a data URI until it is stored
  usageAudit?: UsageAudit;
  advancedEnrichment?: AdvancedEnrichmentMarker;
  localImageEnrichment?: LocalImageEnrichmentMarker;
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
  imageUrl?: string; // A picture marker ('idb:stored', 'server:has_image:<version>'), or a data URI until it is stored
  imagePrompt?: string; // Photorealistic prompt for the complete phrase
  originalQuery?: string; // Original Chinese input if translated
  usageAudit?: UsageAudit;
  localImageEnrichment?: LocalImageEnrichmentMarker;
}

export type {
  AmericanEnglishStatus,
  SentenceAnalysis,
  SentenceAnalysisTerm,
  SentenceGrammarAnalysis,
  SentenceGrammarPoint,
  SentencePronunciationGuide,
} from './server/src/sentence-analysis';

// Sentence — saved example sentence from a vocabulary card
export interface SentenceData {
  id: string;
  text: string; // The sentence text. Markup: {{studied item}} (emphasis) and [[uncommon term]] (clickable lookup)
  sourceWord: string; // The vocab word this sentence came from
  sourceSense?: string; // The sense label of the source word
  /** Last Clear/Casual choice made while reviewing this sentence. */
  preferredSpeechStyle?: 'clear' | 'casual';
  /** Identifies which read-only learning catalog owns an isolated review record. */
  catalogKind?: 'real-life' | 'essay';
  /** Stable provenance id for a sentence originating in a read-only catalog. */
  catalogSentenceId?: string;
  /** Collection or essay boundary for an isolated memorization record. */
  catalogCollectionId?: string;
  /** Human-readable catalog title used when returning from sentence review. */
  catalogTitle?: string;
  imageUrl?: string; // Attached or prepared image (base64/API URL in memory; IDB/server marker once offloaded)
  analysis?: SentenceAnalysis;
  analysisGeneratedAt?: number;
  usageAudit?: UsageAudit;
  localImageEnrichment?: LocalImageEnrichmentMarker;
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
  /**
   * The last completed passive listen, written by builds before wave 2; the client no longer writes it (wave 3
   * removes the field). Merge and the server still read it.
   */
  lastExposureDate?: number;
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

/** Position in the server's (revision, id) change order; a pull resumes after it. */
export interface RevisionCursor {
  revision: number;
  id: string;
}

export type { ReviewRating, ReviewTaskType } from './server/src/shared/review';

export interface ReviewEvent {
  id: string;
  itemId: string;
  itemType: 'vocab' | 'phrase' | 'sentence';
  reviewedAt: number;
  /** The item's total review count before this review. The name is the wire and database field's, from before FSRS. */
  previousStep: number;
  /** The item's total review count after this review. */
  nextStep: number;
  rating?: ReviewRating;
  taskType?: ReviewTaskType;
  durationMs?: number;
  sessionId?: string;
}

/** The review history the study dashboard draws from: recent reviews in full, older ones in brief. */
export interface ReviewHistory {
  /** Every review in the last week or so, oldest first, including this device's unsynced ones. */
  recent: ReviewEvent[];
  /** When the older reviews happened, oldest first, as far back as a streak can reach. */
  olderTimes: number[];
  /** How many older reviews there are, however far back. */
  olderCount: number;
}

// Group type for items with same spelling - Shared across views
export interface ItemGroup {
  title: string;
  items: StoredItem[];
}

export type SyncStatus = 'idle' | 'syncing' | 'saved' | 'error';

export type ViewState = 'notebook' | 'study' | 'sentences' | 'real-life' | 'essays';

// Cached per card: the saved-sense set is rebuilt from every card when the library changes, and cards
// are replaced rather than mutated, so a rebuild builds keys only for the cards that changed.
const savedVocabKeyCache = new WeakMap<VocabCard, string>();

/** Identity of a saved sense: lowercased word plus the exact sense label. */
export const savedVocabKey = (vocab: VocabCard): string => {
  let key = savedVocabKeyCache.get(vocab);
  if (key === undefined) {
    key = `${(vocab.word || '').toLowerCase().trim()}\u0000${vocab.sense || ''}`;
    savedVocabKeyCache.set(vocab, key);
  }
  return key;
};

/**
 * A sense label compared loosely, ignoring case and surrounding space. The duplicate merge and the review popup take
 * 'Noun: emotion' and 'noun: emotion' for one meaning, while saving, search and batch import keep the exact label
 * (savedVocabKey), so there they are two cards.
 */
export const senseMatchKey = (sense: string | undefined): string => (sense || '').toLowerCase().trim();

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
 * Gets the image reference of a stored item (data URI, API URL, or lazy-load marker).
 * @param item - The stored item
 * @returns The marker, data URI or API URL, or undefined if no image
 */
export const getItemImageUrl = (item: StoredItem): string | undefined => {
  if (!item || !item.data) return undefined;
  return item.data.imageUrl;
};

// Word Comparison — AI-generated side-by-side analysis of 2 to MAX_COMPARE_WORDS (services/queryMode.ts) similar words
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

/**
 * Authenticated application user exposed to UI components: AuthUser (services/auth.ts) under Firebase-era field
 * names, which App.tsx translates for the Notebook and UserMenu.
 * @deprecated Pass AuthUser instead (client-data-15); this goes once those two take it.
 */
export interface AppUser {
  uid: string;
  displayName?: string | null;
  photoURL?: string | null;
  email?: string | null;
}
