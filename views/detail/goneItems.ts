// Items deleted on another device, as the open card view meets them: they leave the view, and the writes the view
// makes on its own never bring them back.
import { useEffect, useRef } from 'react';
import type { ItemGroup, SentenceData, StoredItem } from '../../types';

/** What tells whether an id is live in the library: a Set of ids, or a Map keyed by them. */
export interface LiveIds {
  has(id: string): boolean;
}

/** The ids in `viewIds` that the library held (`wasLive`) and no longer does (`liveNow`). */
export function goneFromLibrary(viewIds: Iterable<string>, wasLive: ReadonlySet<string>, liveNow: LiveIds): string[] {
  const gone: string[] = [];
  for (const id of viewIds) if (wasLive.has(id) && !liveNow.has(id)) gone.push(id);
  return gone;
}

/** The ids of the word view's cards. */
export const cardIds = (groups: readonly ItemGroup[]): string[] =>
  groups.flatMap(group => group.items.map(item => item.data.id));

/** The ids among `ids` that the library holds, so the check needn't index the whole library. */
export function liveIdsAmong(ids: readonly string[], library: readonly StoredItem[]): Set<string> {
  const wanted = new Set(ids);
  const live = new Set<string>();
  for (const item of library) if (!item.isDeleted && wanted.has(item.data.id)) live.add(item.data.id);
  return live;
}

/**
 * The ids of a run's sentences that leave it when the library loses them: the learner's own. A Real Life or essay
 * line isn't the learner's to delete, so if its record goes, the line stays, as a line not reviewed yet.
 */
export const ownSentenceIds = (sentenceItems: readonly StoredItem[]): string[] =>
  sentenceItems.filter(item => !(item.data as SentenceData).catalogSentenceId).map(item => item.data.id);

/**
 * Takes each item of the open view that the library held and no longer does, as when another device deleted it, out
 * of the view (onRemoveFromView), once. An item the view never saw live, such as an unsaved card or an example
 * preview, is never gone; nor is one deleted here, which the delete already took out of the view, so an undo still
 * puts it back. `viewIds` and `liveNow` should keep their identity between library changes. Without onRemoveFromView
 * it does nothing, and a deleted item stays open as before.
 */
export function useLeaveGoneItems(
  viewIds: readonly string[],
  liveNow: LiveIds | null,
  onRemoveFromView: ((id: string) => void) | undefined,
): void {
  const wasLiveRef = useRef(new Set<string>());
  useEffect(() => {
    if (!onRemoveFromView || !liveNow) return;
    const wasLive = wasLiveRef.current;
    const gone = goneFromLibrary(viewIds, wasLive, liveNow);
    for (const id of viewIds) if (liveNow.has(id)) wasLive.add(id);
    for (const id of gone) {
      wasLive.delete(id);
      onRemoveFromView(id);
    }
  }, [viewIds, liveNow, onRemoveFromView]);
}

/**
 * How the view writes a change it makes on its own to a sentence, such as the voice a listen leaves: 'patch' its live
 * record (onPatchItem, which leaves a deleted item alone); 'create' the record of a Real Life or essay line that has
 * none yet, as its first listen always has; or 'skip' a sentence the library doesn't hold, whether it was deleted
 * on another device or is an unsaved example.
 */
export function automaticWrite({ live, catalogLine }: { live: boolean; catalogLine: boolean }): 'patch' | 'create' | 'skip' {
  if (live) return 'patch';
  return catalogLine ? 'create' : 'skip';
}
