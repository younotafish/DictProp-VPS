import { StoredItem } from '../types';
import { warn } from './logger';

// Smart Merge: Combines Local and Remote data
export const mergeDatasets = (local: StoredItem[], remote: StoredItem[]): StoredItem[] => {
  const map = new Map<string, StoredItem>();

  // Add all local items first
  local.forEach(item => {
    if (item.data && item.data.id) {
      map.set(item.data.id, item);
    }
  });

  // Merge remote items
  remote.forEach(remoteItem => {
    if (!remoteItem.data || !remoteItem.data.id) return;

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
      
      const localHistory = localItem.srs?.totalReviews || localItem.srs?.history?.length || 0;
      const remoteHistory = remoteItem.srs?.totalReviews || remoteItem.srs?.history?.length || 0;
      
      const localTime = localItem.updatedAt || localItem.savedAt || 0;
      const remoteTime = remoteItem.updatedAt || remoteItem.savedAt || 0;
      
      // Deep clone to avoid mutation
      const mergedItem: StoredItem = structuredClone(remoteItem);

      // A. DATA MERGE (Content - Word/Definition)
      // Content usually changes rarely. Trust the most recent update.
      if (localTime > remoteTime) {
          mergedItem.data = JSON.parse(JSON.stringify(localItem.data));
          mergedItem.updatedAt = localTime;
          mergedItem.savedAt = localItem.savedAt;
      }

      // B. SRS MERGE (Learning Progress)
      // Always keep the history with MORE reviews. 
      // If I studied on iPhone (5 reviews) and iPad has old data (2 reviews), iPhone wins regardless of timestamp.
      // If I studied on both offline... this is hard, but "Total Reviews" is a good proxy for "most progress".
      if (localHistory > remoteHistory) {
          mergedItem.srs = JSON.parse(JSON.stringify(localItem.srs));
      } else if (localHistory === remoteHistory) {
          // Tie-breaker: Recency of last review
          const localReview = localItem.srs?.lastReviewDate || 0;
          const remoteReview = remoteItem.srs?.lastReviewDate || 0;
          if (localReview > remoteReview) {
               mergedItem.srs = JSON.parse(JSON.stringify(localItem.srs));
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

      map.set(remoteItem.data.id, mergedItem);
    }
  });

  return Array.from(map.values());
};
