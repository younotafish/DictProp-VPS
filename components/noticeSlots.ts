import { useSyncExternalStore } from 'react';

/**
 * The places in the notice stack (components/AppStatus) where a screen's own notice can appear: 'search' for the
 * search status line, 'progress' for a session's preload. AppStatusPills always renders both, empty and hidden
 * until something portals into them; this publishes their elements, so a portal follows a slot that mounts again
 * instead of losing its pill.
 *
 * One slot outside the stack is published the same way: 'sheets', which App renders in the app root after the page,
 * for the Notebook tools' sheets (components/Sheet).
 */
export type NoticeSlotName = 'search' | 'progress';
type SlotName = NoticeSlotName | 'sheets';

const slots: Record<SlotName, HTMLElement | null> = { search: null, progress: null, sheets: null };
const refs: Partial<Record<SlotName, (element: HTMLElement | null) => void>> = {};
const listeners = new Set<() => void>();

/** The ref AppStatusPills puts on the slot `name`: the same function on every call, so React sets it only on mount and unmount. */
export function noticeSlotRef(name: SlotName): (element: HTMLElement | null) => void {
  return refs[name] ??= (element: HTMLElement | null) => {
    if (slots[name] === element) return;
    slots[name] = element;
    for (const listener of listeners) listener();
  };
}

/** The slot `name`'s element as it is now, or null while it isn't mounted. */
export const readNoticeSlot = (name: SlotName): HTMLElement | null => slots[name];

/** Calls `listener` whenever a slot mounts, unmounts or is replaced; the returned function stops it. */
export function subscribeNoticeSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The slot `name`'s element, for a portal; null until it mounts, and in a server render. */
export const useNoticeSlot = (name: SlotName): HTMLElement | null =>
  useSyncExternalStore(subscribeNoticeSlots, () => slots[name], () => null);

/** The ref App puts on the sheets slot. */
export const sheetSlotRef = noticeSlotRef('sheets');

/** The sheets slot, for a sheet's portal; null until it mounts, and in a server render. */
export const useSheetSlot = (): HTMLElement | null => useNoticeSlot('sheets');
