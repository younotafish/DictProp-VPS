import { useSyncExternalStore } from 'react';

/**
 * A deploy replaces the files an open page was built from. The page hears of it when the service worker
 * installs the new build, or when code for a screen it hasn't opened yet can't be fetched any more, and
 * offers a reload. It never reloads on its own while changes are still on their way to the server, and a
 * reload saves and sends what it can first.
 */
export type UpdateReason = 'service-worker' | 'chunk-load';

let pending: UpdateReason | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** Offers the reload. Code that failed to load is the more pressing news, so it replaces a plain update. */
export function announceUpdate(reason: UpdateReason): void {
  if (pending === reason || pending === 'chunk-load') return;
  pending = reason;
  emit();
}

export function dismissUpdate(): void {
  if (!pending) return;
  pending = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
/** Why a reload is on offer, or null while none is. */
export const pendingUpdate = (): UpdateReason | null => pending;
export const useAppUpdate = (): UpdateReason | null => useSyncExternalStore(subscribe, pendingUpdate);

// Chromium, Firefox and Safari word a failed dynamic import differently; Vite's preload helper adds its own.
const CHUNK_LOAD_ERROR = /dynamically imported module|importing a module script failed|unable to preload/i;

/** Whether `error` is a module the server no longer has (or couldn't send), not a fault in the code itself. */
export const isChunkLoadError = (error: unknown): boolean =>
  error instanceof Error && CHUNK_LOAD_ERROR.test(error.message);

interface ReloadGuard {
  /** Whether a change is still waiting to reach the server: an open undo offer, a review or an edit. */
  hasUnsentChanges: () => boolean;
  /** Saves what's pending on this device and sends what it can, bounded in time. */
  beforeReload: () => Promise<void>;
}

let guard: ReloadGuard | null = null;

/** Installs the app's guard; the returned function removes it again. */
export function setReloadGuard(next: ReloadGuard): () => void {
  guard = next;
  return () => { if (guard === next) guard = null; };
}

/** True while changes wait to be sent, or when that can't be told, so nothing reloads over them. */
export function hasUnsentChanges(): boolean {
  try {
    return guard?.hasUnsentChanges() ?? false;
  } catch {
    return true;
  }
}

let reloading: Promise<void> | null = null;

/** Saves and sends what it can, then reloads the page. Pressing Reload twice reloads once. */
export function reloadApp(): Promise<void> {
  return reloading ??= (async () => {
    try {
      await guard?.beforeReload();
    } catch {
      // What couldn't be sent stays on this device, and the next launch sends it.
    }
    window.location.reload();
  })();
}
