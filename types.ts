export interface VocabCard {
  id: string; // Unique ID
  word: string;
  sense?: string; // Brief label for this specific meaning (e.g., "noun: emotion", "verb: to affect")
  chinese: string;
  ipa: string;
  definition: string;
  synonyms: string[];
  antonyms: string[];
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
}

export type SyncStatus = 'idle' | 'syncing' | 'saved' | 'error';

export type ViewState = 'search' | 'notebook' | 'study';

// Simplified sync state (operation-based sync was removed due to Firestore limits)
export interface SyncState {
  items: StoredItem[];
}

// Helper to get item title (word or query)
export const getItemTitle = (item: StoredItem): string => {
  if (!item || !item.data) return '';
  const data = item.data as any;
  const val = item.type === 'phrase' ? data.query : data.word;
  return String(val || '');
};
