
import { StoredItem, SyncConfig } from '../types';

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
      
      // 0. Respect Deletions
      if (remoteItem.isDeleted && !localItem.isDeleted) {
           const remoteTime = remoteItem.updatedAt || 0;
           const localTime = localItem.updatedAt || 0;
           if (remoteTime > localTime) {
               map.set(remoteItem.data.id, remoteItem);
               return;
           }
      }
      
      if (localItem.isDeleted && !remoteItem.isDeleted) {
           const remoteTime = remoteItem.updatedAt || 0;
           const localTime = localItem.updatedAt || 0;
           if (localTime > remoteTime) {
               // Keep local deletion
               return;
           }
      }

      // 1. Prioritize Learning Progress
      const localHistory = localItem.srs?.history?.length || 0;
      const remoteHistory = remoteItem.srs?.history?.length || 0;

      let winningItem: StoredItem;
      
      if (remoteHistory > localHistory) {
        winningItem = remoteItem;
      } else if (remoteHistory === localHistory) {
        // 2. If progress is same, check recency
        const localTime = localItem.updatedAt || localItem.savedAt || localItem.srs.nextReview || 0;
        const remoteTime = remoteItem.updatedAt || remoteItem.savedAt || remoteItem.srs.nextReview || 0;
        
        winningItem = remoteTime > localTime ? remoteItem : localItem;
      } else {
        winningItem = localItem;
      }
      
      // 3. Preserve local images (remote doesn't have them)
      if (localItem.data) {
        const localData = localItem.data as any;
        const winningData = winningItem.data as any;
        
        if (localData.imageUrl && !winningData.imageUrl) {
          winningData.imageUrl = localData.imageUrl;
        }
        
        // If it's a phrase, preserve vocab images too
        if (localItem.type === 'phrase' && Array.isArray(localData.vocabs) && Array.isArray(winningData.vocabs)) {
          winningData.vocabs.forEach((remoteVocab: any, index: number) => {
            const localVocab = localData.vocabs[index];
            if (localVocab?.imageUrl && !remoteVocab.imageUrl) {
              remoteVocab.imageUrl = localVocab.imageUrl;
            }
          });
        }
      }
      
      map.set(remoteItem.data.id, winningItem);
    }
  });

  return Array.from(map.values());
};

export const pullFromCloud = async (config: SyncConfig): Promise<StoredItem[] | null> => {
    // Legacy pull - not used for Firebase
    return [];
};
export const pushToCloud = async (config: SyncConfig, items: StoredItem[]): Promise<void> => {
    // Legacy push
};
