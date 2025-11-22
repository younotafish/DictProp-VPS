
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

export interface SRSData {
  id: string; // References SearchResult.id or VocabCard.id
  type: 'vocab' | 'phrase';
  nextReview: number; // Timestamp
  interval: number; // In minutes
  easeFactor: number;
  history: number[]; // 0 for fail, 1 for success
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

export type SyncType = 'firebase' | 'custom';

export interface SyncConfig {
  type: SyncType;
  enabled: boolean;
  serverUrl?: string; // For custom server
  apiKey?: string;    // For custom server (Bearer token)
  lastSynced: number;
}

export type SyncStatus = 'idle' | 'syncing' | 'saved' | 'error';

export type ViewState = 'search' | 'notebook' | 'study';
