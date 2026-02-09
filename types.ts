// Word family entry - related words of different parts of speech
export interface WordFamilyEntry {
  word: string;
  pos: string; // Part of speech: noun, verb, adj, adv, etc.
  chinese: string;
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
  originalQuery?: string; // Original Chinese input if translated
}

// SRS Data — Fixed-schedule spaced repetition
export interface SRSData {
  id: string; // References SearchResult.id or VocabCard.id
  type: 'vocab' | 'phrase';
  nextReview: number; // Timestamp
  interval: number; // In minutes
  
  // Display-only mastery score derived from stability
  memoryStrength: number; // 0-100, derived from stability via log mapping
  lastReviewDate: number; // Timestamp of last review
  totalReviews: number; // Total number of successful "remember" taps (= schedule step)
  correctStreak: number; // Current streak of consecutive remembers
  
  // Core scheduling parameter
  stability: number; // Current interval in days (= SCHEDULE[step])
}

// Combined type for storage
export interface StoredItem {
  data: SearchResult | VocabCard;
  type: 'vocab' | 'phrase';
  srs: SRSData;
  savedAt: number;
  updatedAt?: number;
  isDeleted?: boolean; // Soft delete flag for sync
  isArchived?: boolean; // Archive flag - keeps item but excludes from study
  lastSyncedHash?: string; // Local-only: hash of content as last synced to Firestore
}

// Group type for items with same spelling - Shared across views
export interface ItemGroup {
  title: string;
  items: StoredItem[];
}

export type SyncStatus = 'idle' | 'syncing' | 'saved' | 'error';

export type ViewState = 'notebook' | 'study' | 'podcast';

// Simplified sync state (operation-based sync was removed due to Firestore limits)
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
 * Gets the display title of a stored item (word for vocab, query for phrase).
 * @param item - The stored item to get the title from
 * @returns The word or query string, or empty string if not available
 */
export const getItemTitle = (item: StoredItem): string => {
  if (!item || !item.data) return '';
  if (isPhraseItem(item)) {
    return item.data.query || '';
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
export interface ComparisonDimension {
  label: string;
  analysis: string;
  perWord: Record<string, string>;
}

export interface ComparisonExample {
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

// Podcast metadata — stored in Firestore at users/{userId}/podcasts/{podcastId}
export interface PodcastMetadata {
  id: string;
  generatedAt: number;
  mode: 'daily' | 'manual';
  status: 'generating' | 'ready' | 'failed';
  audioPath: string; // Firebase Storage path
  duration: number; // Estimated seconds
  wordCount: number;
  words: { word: string; chinese: string; sense: string }[];
  script: string; // Full text for read-along
}

// Simplified Firebase User type for props
export interface AppUser {
  uid: string;
  displayName?: string | null;
  photoURL?: string | null;
  email?: string | null;
}
