/** Parsing pasted JSON for the import sheet, and wording the server's reply. */

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null;

// The server's first check of each item (POST /api/import in server/src/routes/import.ts): a full item needs its
// data and type, a simplified card a word that isn't blank. The server checks every item more closely after that,
// so an item counted here can still be skipped.
const isImportable = (item: unknown): boolean =>
  isRecord(item) && ((!!item.data && !!item.type) || (typeof item.word === 'string' && item.word.trim() !== ''));

/** The pasted JSON's items worth sending, one object or an array of them, or why there are none. */
export const parseImportText = (text: string): { items: unknown[] | null; error: string | null } => {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const valid = arr.filter(isImportable);
    if (valid.length === 0) {
      return { items: null, error: 'No valid items found. Each item needs at least a "word" field.' };
    }
    return { items: valid, error: null };
  } catch (e) {
    return { items: null, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
};

// The server's reply as a sentence: a JSON error body gives its message, and an HTML error page (a proxy's
// 502, say) is summarized rather than dumped into the dialog.
export const importErrorMessage = (e: unknown): string => {
  if (e instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
  const raw = (e instanceof Error ? e.message : '').trim();
  try {
    const body = JSON.parse(raw);
    if (typeof body?.error === 'string' && body.error) return body.error;
  } catch { /* not JSON */ }
  if (!raw || raw.startsWith('<') || raw.length > 300) return 'Import failed. Please try again.';
  return raw;
};
