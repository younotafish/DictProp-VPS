import type { ReviewEvent, ReviewHistory, RevisionCursor, StoredItem } from '../../types';
import { HttpError, jsonRequest, requestJson } from '../http';
import { publishServerMutation } from '../syncSignals';

// The library on the server: item changes in pages, pushes, and the review history and review mutations.

export interface ItemChanges {
  items: StoredItem[];
  cursor: RevisionCursor;
  hasMore: boolean;
  /** Newest revision the server has issued; older servers omit it. */
  headRevision?: number;
}

// The most changes the server sends in one page (server/src/db.ts getItemsAfterRevision caps the limit at 500).
const ITEM_PAGE_SIZE = 500;
const MAX_ITEM_PAGES = 100_000;

export const loadItemChanges = async (cursor: RevisionCursor, limit = ITEM_PAGE_SIZE): Promise<ItemChanges> => {
  const params = new URLSearchParams({
    afterRevision: String(cursor.revision),
    afterId: cursor.id,
    limit: String(limit),
  });
  return requestJson<ItemChanges>(`/api/items?${params}`, undefined, 'Load item changes');
};

const isAfter = (a: RevisionCursor, b: RevisionCursor): boolean =>
  a.revision > b.revision || (a.revision === b.revision && a.id > b.id);

export interface ItemChangesSince {
  items: StoredItem[];
  /** After the last change, where the next pull starts. */
  cursor: RevisionCursor;
  /**
   * The server's newest revision is older than the starting cursor: its database was replaced, so only a full
   * snapshot can reconcile. No items come back then, and the cursor is the starting one.
   */
  serverBehind: boolean;
}

/** Every change after `from`, page after page. Throws when a page that promises more doesn't move the cursor on. */
export const loadItemChangesSince = async (from: RevisionCursor): Promise<ItemChangesSince> => {
  const items: StoredItem[] = [];
  let cursor = from;
  for (let pageNumber = 0; pageNumber < MAX_ITEM_PAGES; pageNumber++) {
    const page = await loadItemChanges(cursor);
    if (page.headRevision !== undefined && page.headRevision < from.revision) {
      return { items: [], cursor: from, serverBehind: true };
    }
    items.push(...page.items);
    if (!page.hasMore) return { items, cursor: page.cursor, serverBehind: false };
    if (!isAfter(page.cursor, cursor)) throw new Error('Load items cursor did not advance');
    cursor = page.cursor;
  }
  throw new Error('Load items exceeded its page limit');
};

/** The whole library, plus the cursor after its last change, where the next delta pull starts. */
export const loadAllItems = async (): Promise<{ items: StoredItem[]; cursor: RevisionCursor }> => {
  const { items, cursor } = await loadItemChangesSince({ revision: 0, id: '' });
  return { items, cursor };
};

/** What the server kept for a push: new revisions, plus its own copy wherever it kept different content. */
export interface SaveItemsResult {
  revisions: Map<string, number>;
  canonical: Map<string, StoredItem>;
  /** Items the server refuses (invalid, or too large to send), with its reason. The others still save. */
  rejected: Map<string, string>;
  /** Why the push stopped early. The batches before it saved; it and the rest didn't. */
  error?: unknown;
}

const SAVE_BATCH_SIZE = 200;

export const saveItems = async (items: readonly StoredItem[]): Promise<SaveItemsResult> => {
  const saved: SaveItemsResult = { revisions: new Map(), canonical: new Map(), rejected: new Map() };
  const send = async (batch: readonly StoredItem[]): Promise<void> => {
    let result: { revisions?: Record<string, number>; canonical?: StoredItem[] };
    try {
      result = await requestJson('/api/items', jsonRequest('PUT', batch), 'Save items');
    } catch (error) {
      // The server refuses a whole batch for one bad item, so a refused batch is split until each bad
      // item is alone: otherwise it would hold back every save after it.
      if (!(error instanceof HttpError) || (error.status !== 400 && error.status !== 413)) throw error;
      if (batch.length === 1) {
        saved.rejected.set(batch[0].data.id, error.responseBody || error.message);
        return;
      }
      const half = Math.ceil(batch.length / 2);
      await send(batch.slice(0, half));
      await send(batch.slice(half));
      return;
    }
    for (const [id, revision] of Object.entries(result.revisions ?? {})) {
      if (typeof revision === 'number') saved.revisions.set(id, revision);
    }
    for (const item of result.canonical ?? []) saved.canonical.set(item.data.id, item);
  };
  try {
    for (let start = 0; start < items.length; start += SAVE_BATCH_SIZE) {
      await send(items.slice(start, start + SAVE_BATCH_SIZE));
    }
  } catch (error) {
    // What earlier batches saved still has to be recorded, or those items would be sent again.
    if (saved.revisions.size === 0 && saved.canonical.size === 0) throw error;
    saved.error = error;
  }
  if (saved.revisions.size > 0 || saved.canonical.size > 0) publishServerMutation();
  return saved;
};

export const loadReviewHistory = async (recentSince: number): Promise<ReviewHistory> =>
  requestJson(`/api/reviews/history?recentSince=${recentSince}`, undefined, 'Load review history');

export interface AppliedReviewResponse {
  applied: boolean;
  event: ReviewEvent;
  items: StoredItem[];
  /** Each item's revision just before the review; older servers and some replays omit it. */
  baseRevisions?: Record<string, number>;
}

export const applyReviewMutation = async (
  event: ReviewEvent,
  itemIds: string[],
  seedItem?: StoredItem,
): Promise<AppliedReviewResponse> => {
  const result = await requestJson<AppliedReviewResponse>(
    '/api/reviews/apply',
    jsonRequest('POST', { event, itemIds, ...(seedItem ? { seedItem } : {}) }),
    'Apply review',
  );
  publishServerMutation();
  return result;
};

export interface UndoReviewResponse {
  undone: boolean;
  eventId: string;
  items: StoredItem[];
  /** Each item's revision just before the undo; older servers omit it. */
  baseRevisions?: Record<string, number>;
}

export const undoReviewMutation = async (eventId: string): Promise<UndoReviewResponse> => {
  const result = await requestJson<UndoReviewResponse>(
    `/api/reviews/${encodeURIComponent(eventId)}/undo`,
    { method: 'POST' },
    'Undo review',
  );
  publishServerMutation();
  return result;
};
