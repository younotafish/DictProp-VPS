import type { StoredItem } from '../types';
import { getItemContentHash, isItemDirty } from './itemHash';

/** What keeps a changed item on this device for now. */
export interface PushHold {
  /** The item an open undo offer holds back, so an undone change never reaches the server. */
  heldId: string | null;
  /** Items the server refused, with the content it refused: sending that again would be refused again. */
  refused: ReadonlyMap<string, string>;
}

/**
 * Whether `item` has a change the server hasn't acknowledged and that a push should send: it isn't held for
 * an undo, and isn't the content the server refused. An item edited after a refusal is sent again.
 */
export const isUnsent = (item: StoredItem, { heldId, refused }: PushHold): boolean =>
  item.data.id !== heldId && isItemDirty(item) && refused.get(item.data.id) !== getItemContentHash(item);

/** The unsent items among `items`, or among those whose id is in `ids` when it's given. */
export const selectUnsent = (items: readonly StoredItem[], hold: PushHold, ids?: ReadonlySet<string>): StoredItem[] =>
  items.filter(item => (!ids || ids.has(item.data.id)) && isUnsent(item, hold));

/**
 * Whether a change is still waiting to reach the server: an open undo offer, a queued review, or an unsent
 * item. Items the server refused don't count: they wait for the next edit.
 */
export const hasUnsentChanges = (
  items: readonly StoredItem[],
  hold: PushHold,
  countPendingReviews: () => number,
): boolean => hold.heldId !== null || countPendingReviews() > 0 || items.some(item => isUnsent(item, hold));

/** The steps that send what this device hasn't sent yet. */
export interface LeavingFlush {
  /** Ends the undo offer, which sends its change on. */
  closeUndoOffer: () => void;
  /** Saves the library on this device, returning nothing when there's nothing to save. */
  saveLocal: () => Promise<void> | undefined;
  flushReviews: () => Promise<void>;
  push: () => Promise<unknown>;
  /** How long to wait for all that before going ahead anyway. */
  timeoutMs: number;
  /** Hears why the flush stopped; what it didn't send stays on this device. */
  onError: (error: unknown) => void;
}

/**
 * Signing out ends the server session, and reloading for a new version ends the page, so anything this device
 * hasn't sent would wait for the next sign-in or launch. This sends it first, saving on the device, then the
 * reviews, then the items, without letting a slow server hold either up for longer than `timeoutMs`.
 */
export async function sendBeforeLeaving({ closeUndoOffer, saveLocal, flushReviews, push, timeoutMs, onError }: LeavingFlush): Promise<void> {
  closeUndoOffer();
  const flush = (async () => {
    // With nothing to save, the reviews start at once rather than a tick later.
    const saving = saveLocal();
    if (saving) await saving;
    await flushReviews();
    await push();
  })().catch(onError);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([flush, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(timer);
}
