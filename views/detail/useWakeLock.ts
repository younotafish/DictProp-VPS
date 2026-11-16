import { useCallback, useEffect, useRef } from 'react';

/** How long paused auto-play keeps the screen on before letting it sleep. */
export const PAUSED_WAKE_HOLD_MS = 2 * 60_000;

/** The parts of navigator.wakeLock and its sentinel the keeper uses. */
export interface WakeLockApi {
  request: (type: 'screen') => Promise<Pick<WakeLockSentinel, 'released' | 'release'>>;
}

/** The parts of the document the keeper watches. */
export interface WakeLockPage {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener: (type: 'visibilitychange', listener: () => void) => void;
  removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
}

export interface WakeLockTimers {
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface WakeLockKeeper {
  /** Auto-play is on (keep the screen awake) or off (let it sleep). */
  setActive: (active: boolean) => void;
  /** Auto-play paused: the screen stays on for PAUSED_WAKE_HOLD_MS, then may sleep. Resumed: awake again. */
  setPaused: (paused: boolean) => void;
  /** Take the lock again if the system let it go, as after a resume. */
  rearm: () => void;
  dispose: () => void;
  isHeld: () => boolean;
}

/**
 * Keeps the screen awake while auto-play runs. The browser lets a screen wake lock go whenever the page is hidden, so
 * it's taken again when the page comes back, unless auto-play is paused: a pause keeps the lock for its first two
 * minutes only, so paused auto-play doesn't hold the screen on until Stop. Never asks twice at once, and lets go of a
 * lock that arrives after it stopped wanting one.
 */
export function createWakeLockKeeper(
  wakeLock: WakeLockApi,
  page: WakeLockPage,
  timers: WakeLockTimers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: timer => clearTimeout(timer) },
  pausedHoldMs = PAUSED_WAKE_HOLD_MS,
): WakeLockKeeper {
  let active = false;
  let paused = false;
  let sentinel: Pick<WakeLockSentinel, 'released' | 'release'> | null = null;
  let requesting = false;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;

  const isHeld = () => !!sentinel && !sentinel.released;
  // A pause wants the lock only until its hold runs out.
  const wantsLock = () => active && (!paused || pauseTimer !== null);

  const release = () => {
    const held = sentinel;
    sentinel = null;
    if (held && !held.released) void held.release().catch(() => { /* already gone */ });
  };
  const acquire = async () => {
    if (!active || paused || requesting || isHeld() || page.visibilityState !== 'visible') return;
    requesting = true;
    try {
      const lock = await wakeLock.request('screen');
      if (!wantsLock()) { void lock.release().catch(() => {}); return; }
      sentinel = lock;
    } catch {
      // Denied, or the page went out of view meanwhile; the next return to the page asks again.
    } finally {
      requesting = false;
    }
  };
  const clearPauseTimer = () => {
    if (pauseTimer !== null) timers.clearTimeout(pauseTimer);
    pauseTimer = null;
  };
  const onVisibilityChange = () => {
    if (page.visibilityState === 'visible') void acquire();
  };

  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    if (active) {
      page.addEventListener('visibilitychange', onVisibilityChange);
      void acquire();
      return;
    }
    page.removeEventListener('visibilitychange', onVisibilityChange);
    paused = false;
    clearPauseTimer();
    release();
  };

  return {
    setActive,
    setPaused: (next) => {
      if (!active || next === paused) return;
      paused = next;
      clearPauseTimer();
      if (paused) pauseTimer = timers.setTimeout(() => { pauseTimer = null; release(); }, pausedHoldMs);
      else void acquire();
    },
    rearm: () => { void acquire(); },
    dispose: () => setActive(false),
    isHeld,
  };
}

/**
 * Keeps the screen awake while `active` (see createWakeLockKeeper), held for the first two minutes of a pause only.
 * Returns rearm, which takes the lock again if the system let it go. Does nothing where screen wake locks don't exist.
 */
export function useWakeLock(active: boolean, paused: boolean): { rearm: () => void } {
  const keeperRef = useRef<WakeLockKeeper | null>(null);

  useEffect(() => {
    const wakeLock = (navigator as Partial<Pick<Navigator, 'wakeLock'>>).wakeLock;
    if (!wakeLock?.request) return;
    const keeper = createWakeLockKeeper(wakeLock, document);
    keeperRef.current = keeper;
    return () => {
      keeper.dispose();
      keeperRef.current = null;
    };
  }, []);
  useEffect(() => { keeperRef.current?.setActive(active); }, [active]);
  useEffect(() => { keeperRef.current?.setPaused(paused); }, [paused]);

  const rearm = useCallback(() => { keeperRef.current?.rearm(); }, []);
  return { rearm };
}
