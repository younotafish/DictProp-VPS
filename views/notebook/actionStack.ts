import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';

/** How long after a press outside closed a card's actions the click it ends in is ignored. */
export const DISMISS_CLICK_MS = 400;

/**
 * Which card's action stack (Refresh, Archive, Delete) is open in the notebook: one at most. It lives outside React
 * state, so opening a card's stack re-renders that card and the one it closes, not the list.
 */
export interface ActionStackStore {
  /** The card whose actions are open, or null. */
  openId(): string | null;
  /** Opens a card's actions, closing any other card's. */
  open(id: string): void;
  /** Closes whatever is open: an action ran, Esc, a scroll. */
  close(): void;
  /** A press outside the open stack, at `now`, closed it; the click that press ends in only closes it (justDismissed). */
  dismiss(now: number): void;
  /** Whether a press outside closed a stack in the 400 ms before `now`, so a click now is that press's and opens nothing. */
  justDismissed(now: number): boolean;
  subscribe(listener: () => void): () => void;
}

export function createActionStackStore(): ActionStackStore {
  let openId: string | null = null;
  let dismissedAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();
  const show = (id: string | null) => {
    if (id === openId) return;
    openId = id;
    for (const listener of [...listeners]) listener();
  };
  return {
    openId: () => openId,
    open: id => show(id),
    close: () => show(null),
    dismiss: now => {
      if (openId === null) return;
      dismissedAt = now;
      show(null);
    },
    justDismissed: now => now >= dismissedAt && now - dismissedAt < DISMISS_CLICK_MS,
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** A store whose stacks never open: cards rendered outside the notebook's list, such as compare mode's inert rows. */
const closedStore: ActionStackStore = {
  openId: () => null,
  open: () => {},
  close: () => {},
  dismiss: () => {},
  justDismissed: () => false,
  subscribe: () => () => {},
};

/** The notebook's store, provided around each list row; the stacks of cards outside it never open. */
export const ActionStackContext = createContext<ActionStackStore>(closedStore);

/**
 * A card's action stack: whether it is open, and the store's ways to open it (closing any other) and close it. A card
 * that unmounts with its stack open (its sense swiped away, its tab hidden) closes it, so it doesn't reopen later.
 */
export function useActionStack(id: string) {
  const store = useContext(ActionStackContext);
  const isOpenNow = useCallback(() => store.openId() === id, [store, id]);
  const isOpen = useSyncExternalStore(store.subscribe, isOpenNow, isOpenNow);
  const open = useCallback(() => store.open(id), [store, id]);
  useEffect(() => () => {
    if (store.openId() === id) store.close();
  }, [store, id]);
  return { isOpen, open, close: store.close, dismiss: store.dismiss, justDismissed: store.justDismissed };
}
