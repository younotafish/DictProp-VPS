import { useSyncExternalStore } from 'react';

/**
 * The places in the notice stack (components/AppStatus) where a screen's own notice can appear: 'search' for the
 * search status line, 'progress' for a session's preload. AppStatusPills always renders both, empty and hidden
 * until something portals into them; this publishes their elements, so a portal follows a slot that mounts again
 * instead of losing its pill.
 */
export type NoticeSlotName = 'search' | 'progress';

const slots: Record<NoticeSlotName, HTMLElement | null> = { search: null, progress: null };
const refs: Partial<Record<NoticeSlotName, (element: HTMLElement | null) => void>> = {};
const listeners = new Set<() => void>();

/** The ref AppStatusPills puts on the slot `name`: the same function on every call, so React sets it only on mount and unmount. */
export function noticeSlotRef(name: NoticeSlotName): (element: HTMLElement | null) => void {
  return refs[name] ??= (element: HTMLElement | null) => {
    if (slots[name] === element) return;
    slots[name] = element;
    for (const listener of listeners) listener();
  };
}

/** The slot `name`'s element as it is now, or null while it isn't mounted. */
export const readNoticeSlot = (name: NoticeSlotName): HTMLElement | null => slots[name];

/** Calls `listener` whenever a slot mounts, unmounts or is replaced; the returned function stops it. */
export function subscribeNoticeSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The slot `name`'s element, for a portal; null until it mounts, and in a server render. */
export const useNoticeSlot = (name: NoticeSlotName): HTMLElement | null =>
  useSyncExternalStore(subscribeNoticeSlots, () => slots[name], () => null);
