import type { SRSData, StoredItem } from '../types';
import type { AppliedReviewResponse } from './api/library';
import type { PendingReviewMutation } from './reviewQueue';

/** What draining the review outbox reads, sends and records. */
export interface ReviewOutboxDrain {
  /** The reviews waiting in the outbox, oldest first. */
  read: () => PendingReviewMutation[];
  /** Applies a review on the server. */
  apply: (mutation: PendingReviewMutation) => Promise<AppliedReviewResponse>;
  /** Whether the server refused the review for good, so a retry would be refused the same way. */
  isRefused: (error: unknown) => boolean;
  /** Adopts the copies the server kept for an applied review. */
  reconcile: (response: AppliedReviewResponse) => Promise<void>;
  /** Records a refused review, so the user hears of it. */
  recordRefusal: (mutation: PendingReviewMutation, error: unknown) => void;
  /** Takes a review out of the outbox. */
  remove: (eventId: string) => void;
  /** Marks the reviewed items unsynced, so the item push carries a refused review's schedule instead. */
  markUnsynced: (itemIds: readonly string[]) => Promise<void>;
}

/**
 * Sends the outbox's reviews one at a time, oldest first, including reviews queued while it runs. A refused
 * review is recorded and dropped, and its schedule left to the item push, since a retry would be refused the
 * same way and hold back every review queued behind it. Any other failure stops the drain and keeps the rest
 * queued for the next one. A review the outbox won't let go of isn't sent twice in one drain: the next drain
 * resends it, and the server ignores a review it has applied.
 *
 * The outbox is read once per pass, not once per review: a pass sends what the read found, and the next pass
 * picks up the reviews queued meanwhile, which are newer, so the order holds. Nothing else takes a review out
 * during a pass: useReviewOutbox runs one drain at a time (across tabs too, through a Web Lock where the browser
 * has them), and undoing a review waits for the drain. A review another tab's drain sent first anyway is one
 * the server has applied, so it ignores the repeat.
 */
export async function drainReviewOutbox(outbox: ReviewOutboxDrain): Promise<void> {
  const sent = new Set<string>();
  for (;;) {
    const pending = outbox.read().filter(mutation => !sent.has(mutation.event.id));
    if (pending.length === 0) return;
    for (const mutation of pending) {
      sent.add(mutation.event.id);
      let response: AppliedReviewResponse;
      try {
        response = await outbox.apply(mutation);
      } catch (error) {
        if (!outbox.isRefused(error)) throw error;
        outbox.recordRefusal(mutation, error);
        outbox.remove(mutation.event.id);
        await outbox.markUnsynced(mutation.itemIds);
        continue;
      }
      await outbox.reconcile(response);
      outbox.remove(mutation.event.id);
    }
  }
}

/**
 * The copy a review carries for a server that has never stored its item: an implicit catalog sentence on its
 * first review, or an item saved offline or whose first push hasn't landed (no server revision yet). The item
 * push waits for the review, so without a seed the server would have nothing to apply the review to, and the
 * two would wait on each other forever. The seed holds the schedule from before the review.
 */
export function reviewSeed(target: StoredItem, baseSrs: SRSData, catalogSeed?: StoredItem): StoredItem | undefined {
  return catalogSeed ?? (target.serverRevision === undefined
    ? { ...target, srs: { ...baseSrs, id: target.data.id } }
    : undefined);
}
