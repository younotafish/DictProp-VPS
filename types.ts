
export interface VocabCard {
  id: string; // Unique ID
  word: string;
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

// ============================================
// OPERATION-BASED SYNC SYSTEM
// ============================================

/**
 * Represents a single atomic change to the data
 * Every user action (create, update, delete) becomes an operation
 */
export interface SyncOperation {
  id: string; // Format: `${deviceId}_${timestamp}_${nonce}`
  deviceId: string; // Unique identifier for this device
  timestamp: number; // When operation was created
  type: 'create' | 'update' | 'delete';
  itemId: string; // ID of the item being modified
  
  // For field-level updates (allows merging edits to different fields)
  field?: string; // Path like "data.definition" or "srs.interval"
  value?: any; // New value for the field
  
  // For full item operations
  item?: StoredItem; // Used for 'create' operations
  
  // Metadata
  applied?: boolean; // Whether this op has been applied locally
  synced?: boolean; // Whether this op has been synced to cloud
}

/**
 * The complete sync state for the application
 * Maintains both the current state and operation history
 */
export interface SyncState {
  // Current derived state (computed from operations)
  items: StoredItem[];
  
  // Operation log (last 1000 operations for conflict resolution)
  operations: SyncOperation[];
  
  // Pending operations not yet synced to server
  pendingOps: SyncOperation[];
  
  // Last operation ID we've synced to server
  lastSyncedOpId: string | null;
  
  // Device identifier for this device
  deviceId: string;
}
