import { once } from 'node:events';
import type { Writable } from 'node:stream';

/**
 * Writes text to a stream in pieces of about `chunkSize` characters and waits whenever the stream is full, so a large
 * output never exists as one string and never piles up in the stream's buffer behind a slow reader (gzip, ssh).
 */
export function createChunkedWriter(stream: Writable, chunkSize = 1 << 20) {
  let pending: string[] = [];
  let pendingLength = 0;
  const flush = async (): Promise<void> => {
    if (pendingLength === 0) return;
    const chunk = pending.join('');
    pending = [];
    pendingLength = 0;
    if (!stream.write(chunk)) await once(stream, 'drain');
  };
  return {
    async write(text: string): Promise<void> {
      pending.push(text);
      pendingLength += text.length;
      if (pendingLength >= chunkSize) await flush();
    },
    /** Writes out whatever is still buffered. The stream stays open. */
    flush,
  };
}
