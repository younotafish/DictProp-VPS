import { fetchWithin } from '../http';

// The bulk JSON import, which adds items (and fetches their remote pictures) on the server.

// The server fetches an import's remote pictures before it saves the cards and replies: at most 100, five at a
// time, for eight minutes at most (IMAGE_PHASE_DEADLINE_MS in server/src/routes/import.ts). Four minutes more cover
// sending the request (up to 25 MB), saving the cards and the reply. Past that, the request is given up rather than
// left spinning.
const IMPORT_TIMEOUT_MS = 8 * 60_000 + 4 * 60_000;

/**
 * Imports items. A failure throws an Error whose message is the server's reply (a JSON error body or text), which
 * the import dialog reads, or a sentence when the server never answered in time.
 */
export const importJSON = async (
  items: unknown[],
): Promise<{ ok: boolean; imported: number; skipped: number; imagesFetched: number }> => {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  };
  try {
    return await fetchWithin('/api/import', init, IMPORT_TIMEOUT_MS, async (res) => {
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `Import failed: ${res.status}`);
      }
      return res.json();
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        'The server took too long to answer. The import may still finish, so check your notebook before importing again.',
        { cause: error },
      );
    }
    throw error;
  }
};
