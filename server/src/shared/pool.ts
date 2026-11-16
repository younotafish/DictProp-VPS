// The one bounded worker pool: speech generation (POST /api/tts/generate), the speech backfill and bulk import
// (POST /api/import) run their batches on it, as do the client's clip warm-ups (services/audio/clipWarmers.ts) and
// the session preload's pictures (components/SessionPreload.tsx). It imports nothing, like everything in this folder,
// so client code can run on it too.

/**
 * Runs `work` over the items in order, at most `concurrency` at a time. Once `signal` aborts, no further item
 * starts; the ones already running finish. An item that rejects rejects the pool at once and ends its own worker,
 * while the other workers go on with the remaining items, so work that can fail should catch its own errors.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++;
      await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
