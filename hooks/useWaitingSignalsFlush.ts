import { useEffect } from 'react';

// The study signals and Learn later changes a lesson left waiting (offline, or closed before they went) are sent as the
// connection comes back and as the app comes to the front, wherever the learner is, not only when a lesson next opens.
// Their code (services/studyEvents.ts, services/learnLater.ts) loads only when something is waiting, so the app's first
// chunk carries just this check.

const waitingPrefixes = (userId: string) => [`study_events_pending_${userId}:`, `learn_later_pending_${userId}:`];

/** Whether anything waits for `userId` in this browser's storage. */
export function hasWaitingSignals(userId: string, storage: Pick<Storage, 'key' | 'length'> | null): boolean {
  if (!storage) return false;
  try {
    const prefixes = waitingPrefixes(userId);
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key && prefixes.some(prefix => key.startsWith(prefix))) return true;
    }
  } catch {
    // Storage refused: nothing to send from it.
  }
  return false;
}

export function useWaitingSignalsFlush(userId: string): void {
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') return;
      let storage: Storage | null = null;
      try { storage = localStorage; } catch { /* unavailable */ }
      if (!hasWaitingSignals(userId, storage)) return;
      void import('../services/studyEvents').then(module => module.flushStudyEvents(userId)).catch(() => {});
      void import('../services/learnLater').then(module => module.flushLearnLater(userId)).catch(() => {});
    };
    flush();
    window.addEventListener('online', flush);
    window.addEventListener('focus', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('online', flush);
      window.removeEventListener('focus', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [userId]);
}
