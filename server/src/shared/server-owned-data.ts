// Fields only server-side jobs write. A client or an importer can save an item from a copy made before such a
// job ran, so the server's write path and the client's merge both keep the stored value of a field a save leaves
// out. They must agree field for field, which is why both run this one copy (see README.md).

export const SERVER_OWNED_FIELDS = ['usageAudit', 'advancedEnrichment', 'localImageEnrichment'] as const;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => !!value && typeof value === 'object';

/** `target` with each server-owned field it lacks taken from `stored`; `target` itself when nothing is missing. */
export function withServerOwnedFields<T>(target: T, stored: unknown): T {
  if (!isObject(target) || !isObject(stored)) return target;
  let result: Fields = target;
  for (const field of SERVER_OWNED_FIELDS) {
    if (result[field] === undefined && stored[field] !== undefined) {
      if (result === target) result = { ...target };
      result[field] = stored[field];
    }
  }
  return result as T;
}

/**
 * Keep the server-owned fields a current write omits: the item's own, each phrase vocab's by id, and a
 * sentence's analysis while its text is unchanged (an analysis of other text would be wrong). Items of another
 * type keep nothing. Returns `data` itself when nothing is kept.
 */
export function keepServerOwnedData<T>(data: T, type: string, stored: unknown, storedType: string): T {
  if (type !== storedType || !isObject(data) || !isObject(stored)) return data;
  let result: Fields = withServerOwnedFields(data, stored);
  if (type === 'sentence' && result.analysis === undefined && stored.analysis !== undefined &&
      result.text === stored.text) {
    result = { ...result, analysis: stored.analysis, analysisGeneratedAt: stored.analysisGeneratedAt };
  }
  if (type === 'phrase' && Array.isArray(result.vocabs) && Array.isArray(stored.vocabs)) {
    const storedVocabs = new Map<string, Fields>();
    for (const vocab of stored.vocabs) if (isObject(vocab) && typeof vocab.id === 'string') storedVocabs.set(vocab.id, vocab);
    let changed = false;
    const vocabs = result.vocabs.map((vocab: unknown) => {
      if (!isObject(vocab) || typeof vocab.id !== 'string') return vocab;
      const kept = withServerOwnedFields(vocab, storedVocabs.get(vocab.id));
      if (kept !== vocab) changed = true;
      return kept;
    });
    if (changed) result = { ...result, vocabs };
  }
  return result as T;
}
