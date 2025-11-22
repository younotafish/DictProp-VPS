
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
      // New item from cloud
      map.set(remoteItem.data.id, remoteItem);
    } else {
      // Conflict Resolution
      // 0. Respect Deletions
      if (remoteItem.isDeleted && !localItem.isDeleted) {
           // If remote is deleted and newer than local, delete local
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

      if (remoteHistory > localHistory) {
        map.set(remoteItem.data.id, remoteItem);
      } 
      // 2. If progress is same, check recency
      else if (remoteHistory === localHistory) {
         const localTime = localItem.updatedAt || localItem.savedAt || localItem.srs.nextReview || 0;
         const remoteTime = remoteItem.updatedAt || remoteItem.savedAt || remoteItem.srs.nextReview || 0;
         
         if (remoteTime > localTime) {
             map.set(remoteItem.data.id, remoteItem);
         }
      }
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
