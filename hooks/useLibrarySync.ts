import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoredItem, SyncStatus } from '../types';
import { logout, type AuthUser } from '../services/auth';
import { deleteItemRecords, loadData, saveData, storeMissingItemHashes, subscribeLibraryWriteFailures } from '../services/storage';
import { dropExpiredTombstones } from '../services/sync';
import { getItemContentHash, isItemDirty } from '../services/itemHash';
import { stripAndStoreImages } from '../services/libraryImages';
import { setReloadGuard } from '../services/appUpdate';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { overlayPendingReviews, readPendingReviewMutations } from '../services/reviewQueue';
import { subscribeToServerMutations } from '../services/syncSignals';
import { log, warn, error as logError } from '../services/logger';
import { useLatest } from './useStableValue';
import type { Library } from './useLibrary';

// Older builds mirrored the library into localStorage. It never fit, and its stripped copies could
// overwrite full items, so drop them and leave the quota to the synchronous review outbox. The open card's
// saved context goes too: restoring it crashed DetailView on stale items, so it's no longer read.
const clearLegacyLibraryCaches = (): void => {
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith('vps_items_cache') || key?.startsWith('popdict_items') || key === 'app_last_hidden' || key === 'app_detail_context') {
        localStorage.removeItem(key);
      }
    }
  } catch { /* storage unavailable */ }
};

// How long signing out, or reloading for a new version, waits for this device's unsent changes before it
// goes ahead anyway.
const SIGN_OUT_FLUSH_MS = 10_000;

/**
 * Loading the library from this device and keeping it saved there, and syncing it with the server: the first
 * sync, the background pulls, the debounced pushes, and sending what's unsent before a sign-out or a reload.
 */
export function useLibrarySync(
  user: AuthUser | null,
  library: Library,
  { flushPendingReviews, closeUndoOffer, prefetchImages }: {
    flushPendingReviews: () => Promise<void>;
    closeUndoOffer: () => void;
    prefetchImages: (items: StoredItem[], mode?: 'priority' | 'all') => Promise<void>;
  },
) {
  const {
    savedItems, latestItemsRef, serverCursorRef, updateItems, currentUserIdRef, userSaveData, initialServerSyncDoneRef,
    initialSyncIncompleteRef, inSyncLane, refusedPushesRef, undoOfferRef, pushNow, pushDirtyItems, syncFullSnapshot, syncWithServer,
  } = library;
  // Becomes true once IndexedDB has been read (or failed), whether or not it held any items.
  const [isLoaded, setIsLoaded] = useState(false);
  // This device's library couldn't be read; the launch waits for a retry or an explicit choice of the
  // server copy, so the server's copy doesn't overwrite unsynced changes still stored here.
  const [libraryReadFailed, setLibraryReadFailed] = useState(false);
  const [libraryLoadAttempt, setLibraryLoadAttempt] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');

  // Saving the library on this device keeps failing (storage full, say): unsynced changes then live only in
  // this tab until they reach the server.
  const [libraryWriteFailed, setLibraryWriteFailed] = useState(false);
  useEffect(() => subscribeLibraryWriteFailures(setLibraryWriteFailed), []);

  // Force sync — uploads changed items, pulls remote, merges
  const forceSyncInProgressRef = useRef(false);
  const handleForceSync = useCallback(async () => {
    if (forceSyncInProgressRef.current) return;
    forceSyncInProgressRef.current = true;

    setSyncStatus('syncing');

    try {
      await flushPendingReviews();
      await inSyncLane(async () => {
        await syncFullSnapshot();
        const pushed = await pushNow();
        if (pushed > 0) log(`Server: Force sync uploaded ${pushed} changed items`);
      });
      setSyncStatus('saved');
    } catch (e) {
      logError("Force Sync Failed:", e);
      setSyncStatus('error');
    } finally {
      forceSyncInProgressRef.current = false;
    }
  }, [flushPendingReviews, inSyncLane, syncFullSnapshot, pushNow]);

  // Signing out ends the server session, and reloading for a new version ends the page, so anything this
  // device hasn't sent would wait for the next sign-in or launch. Send it first, without letting a slow
  // server hold either up for long.
  const sendUnsentChanges = useCallback(async (): Promise<void> => {
    closeUndoOffer();
    const flush = (async () => {
      if (isLoaded && latestItemsRef.current.length > 0) await userSaveData(latestItemsRef.current);
      await flushPendingReviews();
      await pushDirtyItems();
    })().catch(error => warn('Unsent changes stay on this device until the next launch:', error));
    let timer = 0;
    await Promise.race([flush, new Promise<void>(resolve => { timer = window.setTimeout(resolve, SIGN_OUT_FLUSH_MS); })]);
    window.clearTimeout(timer);
  }, [closeUndoOffer, isLoaded, userSaveData, flushPendingReviews, pushDirtyItems]);

  const handleSignOut = useCallback(async (): Promise<boolean> => {
    await sendUnsentChanges();
    return logout();
  }, [sendUnsentChanges]);

  // A new version's reload waits for changes still on their way to the server (services/appUpdate), and
  // sends them first. Items the server refused don't count: they wait for the next edit.
  useEffect(() => setReloadGuard({
    hasUnsentChanges: () => {
      const refused = refusedPushesRef.current;
      return !!undoOfferRef.current || readPendingReviewMutations(currentUserIdRef.current).length > 0 ||
        latestItemsRef.current.some(item => isItemDirty(item) && refused.get(item.data.id) !== getItemContentHash(item));
    },
    beforeReload: sendUnsentChanges,
  }), [sendUnsentChanges]);

  // Save data before page unload (refresh, close tab, navigate away)
  // This is a critical safety net to prevent data loss
  useEffect(() => {
    const handleBeforeUnload = () => {
      const currentItems = latestItemsRef.current;
      if (isLoaded && currentItems.length > 0) {
        // Reviews are already in the synchronous outbox; IndexedDB may not finish but is worth trying.
        // Only items replaced since their last write are written, so this is cheap when nothing changed.
        userSaveData(currentItems).catch(e => warn("Failed to save on beforeunload:", e));
      }
    };

    // iOS Safari often skips beforeunload; pagehide fires there as the page goes away.
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
    };
  }, [isLoaded, userSaveData]);

  // Save data when app goes to background. Returning triggers the delta pull below.
  useEffect(() => {
      const handleVisibilityChange = () => {
          if (document.visibilityState === 'visible') {
              window.speechSynthesis?.cancel();
          } else {
              const currentItems = latestItemsRef.current;
              if (isLoaded && currentItems.length > 0) {
                  userSaveData(currentItems).catch(e => {
                      warn("Failed to save on visibility change:", e);
                  });
                  // Best-effort server push before the OS suspends the page
                  pushDirtyItems().catch(e => {
                      warn("Server push on background failed:", e);
                  });
              }
          }
      };

      const handleBeforeExternalNav = () => {
        const currentItems = latestItemsRef.current;
        if (!isLoaded || currentItems.length === 0) return;
        log("💾 Saving state before external navigation...");
        userSaveData(currentItems).catch(e => {
          warn("Failed to save to IDB before external nav:", e);
        });
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('dictprop:before-external-nav', handleBeforeExternalNav);
      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('dictprop:before-external-nav', handleBeforeExternalNav);
      };
  }, [isLoaded, userSaveData, pushDirtyItems]);

  // 1. Initialize Local Storage (Load from IndexedDB) + Auto-migrate SRS
  useEffect(() => {
    if (!user) return;
    const userId = user.id;
    const initStorage = async () => {
        try {
            clearLegacyLibraryCaches();
            // IndexedDB is the only local copy of the library; the server sync fills anything it lacks.
            const stored = await loadData(userId);
            const loadedItems = stored.items.filter(item =>
                item && item.data && item.data.id && item.srs && item.type
            );
            // The server won't resend a skipped record's changes, so a skipped record needs a full sync.
            const cursor = loadedItems.length === stored.items.length ? stored.cursor : null;
            log(`📦 Loaded ${loadedItems.length} items from IndexedDB`);

            // Each migration replaces only the items it changes, so the save below writes just those.
            const now = Date.now();
            let processedItems = loadedItems.map(item => {
                let migrated = item;
                // 1. SRS migration
                if (typeof migrated.srs?.memoryStrength !== 'number' ||
                    (migrated.type === 'sentence' && (migrated.srs?.totalReviews ?? 0) === 0 &&
                        ((migrated.srs?.memoryStrength ?? 0) !== 0 || (migrated.srs?.stability ?? 0.5) !== 0.5))) {
                    migrated = { ...migrated, srs: SRSAlgorithm.migrate(migrated.srs) };
                }
                // 2. Timestamp fix (for sync)
                if (!migrated.updatedAt && !migrated.savedAt) {
                    migrated = { ...migrated, savedAt: now, updatedAt: now };
                }
                // 3. Merge every legacy project into the one notebook without touching card content or SRS.
                if (migrated.project !== undefined) {
                    const { project: _legacyProject, ...withoutProject } = migrated;
                    migrated = withoutProject;
                }
                return migrated;
            });

            // 4. A review mutation is written synchronously before the async IndexedDB write. Reapply
            // those tiny patches here so an immediate refresh cannot roll progress back. The review
            // outbox delivers them, so a clean item stays clean, as in updateSRS.
            const beforeOverlay = processedItems;
            processedItems = overlayPendingReviews(beforeOverlay, readPendingReviewMutations(userId))
                .map((item, index) => item !== beforeOverlay[index] && !isItemDirty(beforeOverlay[index])
                    ? { ...item, lastSyncedHash: getItemContentHash(item) }
                    : item);

            // 5. Strip images from items → IDB (keep ~143MB out of React state). If they can't be stored,
            // they stay inline for now and the next launch tries again.
            processedItems = await stripAndStoreImages(processedItems).catch(error => {
                warn('Inline images stay in memory until the next launch:', error);
                return processedItems;
            });

            // 6. Tombstones past retention have reached every device
            const pruned = dropExpiredTombstones(processedItems);
            processedItems = pruned.items;
            await deleteItemRecords(pruned.droppedIds, userId)
                .catch(error => warn('Expired deletions stay stored until the next launch:', error));

            updateItems(() => processedItems);
            serverCursorRef.current = cursor;

            // 7. Write back the items the steps above replaced
            await saveData(processedItems, userId);
            setIsLoaded(true);
        } catch (e) {
            logError("Failed to initialize storage", e);
            setLibraryReadFailed(true);
        }
    };
    initStorage();
  }, [user?.id, libraryLoadAttempt]);

  // 2. SERVER SYNC — once local data is loaded, pull what changed since it was stored
  useEffect(() => {
    if (!isLoaded) return;
    const syncFromServer = async () => {
      try {
        await flushPendingReviews();
        await inSyncLane(async () => {
          // Server items carry image markers, never base64, so there is nothing to strip.
          await syncWithServer();
          const pushed = await pushNow();
          if (pushed > 0) log(`Server: uploaded ${pushed} items that differed from the server`);
        });
        void prefetchImages(latestItemsRef.current);
      } catch (error) {
        logError("Initial server sync failed:", error);
        initialSyncIncompleteRef.current = true;
      } finally {
        initialServerSyncDoneRef.current = true;
      }
      storeMissingItemHashes(currentUserIdRef.current)
        .catch(error => warn('Storing item hashes will retry on the next launch:', error));
    };
    void syncFromServer();
  }, [isLoaded, flushPendingReviews, inSyncLane, syncWithServer, pushNow, prefetchImages]);

  const deltaPullInProgressRef = useRef(false);
  const pullServerChanges = useCallback(async () => {
    if (!user || !initialServerSyncDoneRef.current || deltaPullInProgressRef.current ||
        !navigator.onLine || document.visibilityState !== 'visible') return;
    deltaPullInProgressRef.current = true;
    try {
      await flushPendingReviews();
      await inSyncLane(async () => {
        await syncWithServer();
        if (!initialSyncIncompleteRef.current) return;
        await pushNow();
        initialSyncIncompleteRef.current = false;
        void prefetchImages(latestItemsRef.current);
      });
    } catch (error) {
      warn('Background sync will retry:', error);
    } finally {
      deltaPullInProgressRef.current = false;
    }
  }, [user?.id, flushPendingReviews, inSyncLane, syncWithServer, pushNow, prefetchImages]);

  useEffect(() => {
    if (!isLoaded || !user) return;
    const tick = () => { void pullServerChanges(); };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    const timer = window.setInterval(tick, 8_000);
    const unsubscribe = subscribeToServerMutations(tick);
    window.addEventListener('online', tick);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', handleVisibility);
    tick();
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener('online', tick);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isLoaded, user?.id, pullServerChanges]);

  // 3. SAVE EFFECTS (Persistence + Server Sync)
  // Changes reach this device's storage a moment after they settle, so closing the page, a crash or the OS
  // discarding a background tab loses at most that moment. Only items replaced since their last write are
  // written. Unmounting (the app-wide error screen) writes what's pending instead of dropping it.
  const userSaveDataRef = useLatest(userSaveData);
  useEffect(() => {
    if (!isLoaded) return;
    const timer = setTimeout(() => {
      userSaveData(latestItemsRef.current).catch(e => logError("Local save error:", e));
    }, 300);
    return () => clearTimeout(timer);
  }, [savedItems, isLoaded, userSaveData]);
  useEffect(() => () => {
    if (latestItemsRef.current.length > 0) {
      userSaveDataRef.current(latestItemsRef.current).catch(e => logError("Local save on unmount failed:", e));
    }
  }, [userSaveDataRef]);

  // The server push waits for changes to pause for 5 s, but a steady stream of changes (a study session)
  // holds it back for at most 30 s.
  const pushDeadlineRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isLoaded) return;

    const now = Date.now();
    pushDeadlineRef.current ??= now + 30_000;
    const timer = setTimeout(async () => {
      pushDeadlineRef.current = null;
      try {
        // Writes only the items replaced since their last write.
        await userSaveData(latestItemsRef.current);
        if (!latestItemsRef.current.some(isItemDirty)) {
          setSyncStatus('saved');
          return;
        }
        setSyncStatus('syncing');
        // Items waiting on the review outbox are skipped, which leaves nothing pushed.
        const pushed = await pushDirtyItems();
        setSyncStatus(pushed > 0 ? 'saved' : 'idle');
      } catch (e) {
        logError("Sync error:", e);
        setSyncStatus('error');
      }
    }, Math.max(0, Math.min(5_000, pushDeadlineRef.current - now)));

    return () => clearTimeout(timer);
  }, [savedItems, isLoaded, userSaveData, pushDirtyItems]);

  // What the screen for an unreadable library offers: another try, or the server's copy.
  const retryLibraryLoad = () => { setLibraryReadFailed(false); setLibraryLoadAttempt(attempt => attempt + 1); };
  const openWithServerCopy = () => { setLibraryReadFailed(false); setIsLoaded(true); };

  return { isLoaded, libraryReadFailed, retryLibraryLoad, openWithServerCopy, syncStatus, libraryWriteFailed, handleForceSync, handleSignOut };
}
