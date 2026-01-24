export interface VocabCard {
  id: string; // Unique ID
  word: string;
  sense?: string; // Brief label for this specific meaning (e.g., "noun: emotion", "verb: to affect")
  chinese: string;
  ipa: string;
  definition: string;
  forms?: string[]; // Different forms of the word (e.g., run → runs, running, ran)
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

// Enhanced SRS with Memory Strength Model
export interface SRSData {
  id: string; // References SearchResult.id or VocabCard.id
  type: 'vocab' | 'phrase';
  nextReview: number; // Timestamp
  interval: number; // In minutes
  easeFactor: number;
  history: number[]; // 0 for fail, 1 for success (legacy)
  
  // Memory Strength System (Shanbay-like)
  memoryStrength: number; // 0-100, hidden from user
  lastReviewDate: number; // Timestamp of last review
  totalReviews: number; // Total number of reviews
  correctStreak: number; // Current streak of correct answers
  
  // Task-specific performance tracking
  taskHistory: TaskPerformance[];
  
  // Forgetting curve parameters
  stability: number; // How stable the memory is (days)
  difficulty: number; // Inherent difficulty of this item (0-10)
}

// Different study task types with different difficulty levels
export type TaskType = 'recognition' | 'recall' | 'typing' | 'listening' | 'sentence';

export interface TaskPerformance {
  taskType: TaskType;
  timestamp: number;
  quality: number; // 0-5 (SuperMemo-like)
  responseTime: number; // milliseconds
  strength: number; // Memory strength at time of review
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

export type ViewState = 'notebook' | 'study';

// Simplified sync state (operation-based sync was removed due to Firestore limits)
export interface SyncState {
  items: StoredItem[];
}

// Helper to get item title (word or query)
export const getItemTitle = (item: StoredItem): string => {
  if (!item || !item.data) return '';
  if (item.type === 'phrase') {
    return (item.data as SearchResult).query || '';
  }
  return (item.data as VocabCard).word || '';
};

// Simplified Firebase User type for props
export interface AppUser {
  uid: string;
  displayName?: string | null;
  photoURL?: string | null;
  email?: string | null;
}
