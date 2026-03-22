import { StoredItem } from '../types';
import { SRSAlgorithm } from './srsAlgorithm';
import { warn } from './logger';

// Polyfill structuredClone for iOS < 15.4
const clone = typeof structuredClone === 'function'
  ? structuredClone
  : <T>(obj: T): T => JSON.parse(JSON.stringify(obj));

// Smart Merge: Combines Local and Remote data
export const mergeDatasets = (local: StoredItem[], remote: StoredItem[]): StoredItem[] => {
  const map = new Map<string, StoredItem>();

  // Add all local items first (ensure SRS exists)
  local.forEach(item => {
    if (item.data && item.data.id) {
      if (!item.srs) item = { ...item, srs: SRSAlgorithm.createNew(item.data.id, item.type) };
      map.set(item.data.id, item);
    }
  });

  // Merge remote items
  remote.forEach(remoteItem => {
    if (!remoteItem.data || !remoteItem.data.id) return;
    // Ensure remote item has SRS data
    if (!remoteItem.srs) remoteItem = { ...remoteItem, srs: SRSAlgorithm.createNew(remoteItem.data.id, remoteItem.type) };

    const localItem = map.get(remoteItem.data.id);

    if (!localItem) {
      // New item from cloud - use as-is
      map.set(remoteItem.data.id, remoteItem);
    } else {
      // Conflict Resolution with Image Preservation
      
      // 0. Respect Deletions (ENHANCED - deletion always wins unless there's a much newer update)
      const DELETION_GRACE_PERIOD = 5000; // 5 seconds grace period for deletions
      
      if (remoteItem.isDeleted && !localItem.isDeleted) {
           const remoteTime = remoteItem.updatedAt || 0;
           const localTime = localItem.updatedAt || 0;
           // Deletion wins if remote is newer OR within grace period
           if (remoteTime >= localTime - DELETION_GRACE_PERIOD) {
               map.set(remoteItem.data.id, remoteItem);
               return;
           }
           // If local update is SIGNIFICANTLY newer (>5s), keep the local update
           // This handles the edge case of offline edits happening after deletion
           warn(`⚠️ Deletion conflict: Remote deleted at ${remoteTime}, but local updated at ${localTime}. Keeping local update.`);
      }
      
      if (localItem.isDeleted && !remoteItem.isDeleted) {
           const remoteTime = remoteItem.updatedAt || 0;
           const localTime = localItem.updatedAt || 0;
           // Deletion wins if local is newer OR within grace period
           if (localTime >= remoteTime - DELETION_GRACE_PERIOD) {
               // Keep local deletion
               map.set(localItem.data.id, localItem);
               return;
           }
           // If remote update is SIGNIFICANTLY newer, keep the remote update
           warn(`⚠️ Deletion conflict: Local deleted at ${localTime}, but remote updated at ${remoteTime}. Keeping remote update.`);
      }
      
      // If BOTH are deleted, use the newest deletion timestamp
      if (localItem.isDeleted && remoteItem.isDeleted) {
           const remoteTime = remoteItem.updatedAt || 0;
           const localTime = localItem.updatedAt || 0;
           if (remoteTime > localTime) {
               map.set(remoteItem.data.id, remoteItem);
           } else {
               map.set(localItem.data.id, localItem);
           }
           return; // Don't merge further for deleted items
      }

      // 1. Smart Field-Level Merging
      // Instead of picking one winner, we merge the best parts of both.
      
      const localHistory = localItem.srs?.totalReviews || 0;
      const remoteHistory = remoteItem.srs?.totalReviews || 0;
      
      const localTime = localItem.updatedAt || localItem.savedAt || 0;
      const remoteTime = remoteItem.updatedAt || remoteItem.savedAt || 0;
      
      // Deep clone to avoid mutation
      const mergedItem: StoredItem = clone(remoteItem);

      // A. DATA MERGE (Content - Word/Definition)
      // SAFETY: Never replace full content with lightweight cache data.
      // The localStorage cache strips most fields (definition, history, examples, etc.)
      // to fit within Safari's 5MB limit. If those stripped items enter the merge
      // (e.g., after iOS clears IDB under storage pressure), we must detect and
      // preserve the version that has full content.
      const localDataFields = localItem.data as any;
      const remoteDataFields = remoteItem.data as any;
      const localHasContent = !!(localDataFields.definition || localDataFields.history || localDataFields.grammar ||
                                (Array.isArray(localDataFields.examples) && localDataFields.examples.length > 0));
      const remoteHasContent = !!(remoteDataFields.definition || remoteDataFields.history || remoteDataFields.grammar ||
                                (Array.isArray(remoteDataFields.examples) && remoteDataFields.examples.length > 0));

      if (localTime > remoteTime) {
          // Only use local data if it has full content, OR remote also lacks content
          if (localHasContent || !remoteHasContent) {
              mergedItem.data = clone(localItem.data);
          }
          // else: local is stripped cache data but remote has full content — keep remote data
          mergedItem.updatedAt = localTime;
          mergedItem.savedAt = localItem.savedAt;
      }

      // B. SRS MERGE (Learning Progress)
      // Priority: most recent lastReviewDate wins.
      // Rationale: lastReviewDate is set to Date.now() on each review, so a more
      // recent value definitively means "this device studied more recently."
      // The overdue penalty can DECREASE totalReviews (e.g., 4→2 after 90+ days),
      // so using totalReviews as primary key would cause old remote data (higher
      // reviews) to overwrite a just-studied local item (lower reviews after penalty).
      // Fallback to totalReviews only when lastReviewDate is equal (same review).
      const localReview = localItem.srs?.lastReviewDate || 0;
      const remoteReview = remoteItem.srs?.lastReviewDate || 0;

      if (localReview > remoteReview) {
          // Local was reviewed more recently — local SRS wins
          mergedItem.srs = clone(localItem.srs);
      } else if (localReview === remoteReview) {
          // Same review timestamp — use totalReviews as tiebreaker
          if (localHistory > remoteHistory) {
              mergedItem.srs = clone(localItem.srs);
          }
      } else if (remoteReview > localReview && localHistory !== remoteHistory) {
          // Remote reviewed more recently — keep remote SRS (already in mergedItem)
          // Log when this causes a totalReviews decrease (potential regression)
          if (localHistory > remoteHistory) {
              console.error(`[MERGE] "${(localItem.data as any).word || (localItem.data as any).query}" SRS: keeping remote (reviewed more recently) reviews ${localHistory}→${remoteHistory}, localReview=${new Date(localReview).toISOString()}, remoteReview=${new Date(remoteReview).toISOString()}`);
          }
      }

      // C. IMAGE MERGE (Preservation for Offline)
      // PRIORITY: Local images ALWAYS win over remote
      // This is critical because:
      // 1. Base64 images work offline (URLs don't)
      // 2. Remote images might be stripped due to Firestore 1MB document limit
      // 3. Local IndexedDB has no size limit and stores full images
      const finalData = mergedItem.data as any;
      const localData = localItem.data as any;
      const remoteData = remoteItem.data as any;
      
      // Main image: LOCAL ALWAYS WINS (since remote might have been stripped)
      if (localData.imageUrl) {
          // Local has an image - always keep it
          finalData.imageUrl = localData.imageUrl;
      } else if (remoteData.imageUrl && !finalData.imageUrl) {
          // Local has no image, but remote does - use remote
          finalData.imageUrl = remoteData.imageUrl;
      }
      
      // Phrase Vocabs Images - same logic: LOCAL WINS
      if (mergedItem.type === 'phrase' && Array.isArray(finalData.vocabs)) {
          finalData.vocabs.forEach((vocab: any, index: number) => {
               const localVocab = Array.isArray(localData.vocabs) ? localData.vocabs[index] : null;
               const remoteVocab = Array.isArray(remoteData.vocabs) ? remoteData.vocabs[index] : null;
               
               // Local image always wins
               if (localVocab?.imageUrl) {
                   vocab.imageUrl = localVocab.imageUrl;
               } else if (remoteVocab?.imageUrl && !vocab.imageUrl) {
                   vocab.imageUrl = remoteVocab.imageUrl;
               }
          });
      }

      // Preserve local sync tracking state through merge
      mergedItem.lastSyncedHash = localItem.lastSyncedHash;

      map.set(remoteItem.data.id, mergedItem);
    }
  });

  return Array.from(map.values());
};
