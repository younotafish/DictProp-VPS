// Fields only server-side jobs write. A client or an importer can save an item from a copy made before such a
// job ran, so the server's write path and the client's merge both keep the stored value of a field a save leaves
// out. They must agree field for field, which is why both run this one copy (see README.md).

export const SERVER_OWNED_FIELDS = ['usageAudit', 'advancedEnrichment', 'localImageEnrichment'] as const;

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => !!value && typeof value === 'object';

/** The server-owned fields `value` holds, and nothing else. */
const ownedFieldsOf = (value: Fields): Fields => {
  const owned: Fields = {};
  for (const field of SERVER_OWNED_FIELDS) if (value[field] !== undefined) owned[field] = value[field];
  return owned;
};

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

/**
 * Only what keepServerOwnedData can take from `stored` for an item of `type`: its server-owned fields, a sentence's
 * analysis with the text it analyzed, and each phrase vocab's server-owned fields by vocab id. Keeping from this part
 * keeps exactly what keeping from `stored` does, so the server can send it to the client whose save it kept fields
 * for. Undefined when there is nothing to take.
 */
export function serverOwnedPart(stored: unknown, type: string): Fields | undefined {
  if (!isObject(stored)) return undefined;
  const part = ownedFieldsOf(stored);
  if (type === 'sentence' && stored.analysis !== undefined) {
    // With the text it analyzed: a copy keeps the analysis only while it has that text.
    for (const key of ['text', 'analysis', 'analysisGeneratedAt']) {
      if (stored[key] !== undefined) part[key] = stored[key];
    }
  }
  if (type === 'phrase' && Array.isArray(stored.vocabs)) {
    // As in keepServerOwnedData, the last vocab with an id is the one whose fields are kept.
    const byId = new Map<string, Fields>();
    for (const vocab of stored.vocabs) if (isObject(vocab) && typeof vocab.id === 'string') byId.set(vocab.id, vocab);
    const vocabs: Fields[] = [];
    for (const [id, vocab] of byId) {
      const owned = ownedFieldsOf(vocab);
      if (Object.keys(owned).length > 0) vocabs.push({ id, ...owned });
    }
    if (vocabs.length > 0) part.vocabs = vocabs;
  }
  return Object.keys(part).length > 0 ? part : undefined;
}
