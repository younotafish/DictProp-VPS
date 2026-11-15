// The rules a write applies when the server already holds the item, as pure functions of the stored row and the
// incoming copy. db/items.ts runs them in order inside the write's transaction.

export type JsonObject = Record<string, unknown>;

/** A JSON object or array, as opposed to a primitive or null. */
export const isJsonObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object';
const isObject = isJsonObject;
const fieldOf = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);
const numberOrZero = (value: unknown): number => Number(value) || 0;

const compareNumbers = (a: number, b: number): number => (a === b ? 0 : a > b ? 1 : -1);

/** 1 when schedule `a` has newer review progress than `b` (a later last review, then more reviews), -1 when older. */
export function compareReviewProgress(a: unknown, b: unknown): number {
  return compareNumbers(numberOrZero(fieldOf(a, 'lastReviewDate')), numberOrZero(fieldOf(b, 'lastReviewDate')))
    || compareNumbers(numberOrZero(fieldOf(a, 'totalReviews')), numberOrZero(fieldOf(b, 'totalReviews')));
}

/**
 * The schedule a write stores over a stored one. Content and learning progress have different conflict clocks: an
 * edit can carry newer content with a schedule loaded before another device reviewed the card, so the schedule
 * with newer review progress wins, whatever happens to the content. A passive listen is independent of review
 * progress, so the newest lastExposureDate always survives. `changed` says the incoming copy brought newer
 * progress or a newer listen, which earns a new revision even when its content is stale.
 */
export function resolveSrs(stored: unknown, incoming: unknown): { srs: unknown; changed: boolean } {
  const order = compareReviewProgress(stored, incoming);
  let srs = order > 0 ? stored : incoming;
  let changed = order < 0;
  const incomingExposure = numberOrZero(fieldOf(incoming, 'lastExposureDate'));
  const storedExposure = numberOrZero(fieldOf(stored, 'lastExposureDate'));
  const latestExposure = Math.max(incomingExposure, storedExposure);
  if (numberOrZero(fieldOf(srs, 'lastExposureDate')) !== latestExposure) {
    srs = { ...(srs as object), lastExposureDate: latestExposure };
  }
  if (incomingExposure > storedExposure) changed = true;
  return { srs, changed };
}

/**
 * Whether the incoming copy was made from an older version of the item than the stored row: by server revision when
 * the copy carries one, otherwise by its updatedAt clock. Stale content is ignored; its schedule still counts.
 */
export function isStaleContent(clocks: {
  storedRevision: number;
  incomingRevision: number | undefined;
  storedUpdatedAt: number;
  incomingUpdatedAt: number;
}): boolean {
  return clocks.incomingRevision !== undefined
    ? clocks.incomingRevision < clocks.storedRevision
    : clocks.incomingUpdatedAt < clocks.storedUpdatedAt;
}

/** A sentence saved without an analysis takes the prepared one from the example-enrichment pool. */
export function withPoolAnalysis(
  data: JsonObject,
  pool: { analysis: unknown; generatedAt: number } | null,
): { data: JsonObject; enriched: boolean } {
  if (!pool || data.analysis) return { data, enriched: false };
  return { data: { ...data, analysis: pool.analysis, analysisGeneratedAt: pool.generatedAt }, enriched: true };
}

export interface InlineImage {
  id: string;
  dataUri: string;
}

/**
 * `data` as the row stores it: without imageUrl on the item or on its phrase vocabs, since image bytes and markers
 * never live in item JSON. The inline images those fields carried come back beside it, to be moved into image
 * storage. Markers and missing images leave stored images alone: a vocab id can also be a standalone item's.
 */
export function splitInlineImages(data: JsonObject): {
  stored: JsonObject;
  itemImage: InlineImage | undefined;
  vocabImages: InlineImage[];
} {
  // SQLite keeps a number id as its text, as item ids are; only phrase vocab ids go unvalidated.
  const inline = (id: unknown, url: unknown): InlineImage | undefined =>
    (typeof id === 'string' || typeof id === 'number') && id && typeof url === 'string' && url.startsWith('data:image/')
      ? { id: String(id), dataUri: url }
      : undefined;
  const { imageUrl: _imageUrl, ...stored } = data;
  const vocabImages: InlineImage[] = [];
  if (Array.isArray(data.vocabs)) {
    stored.vocabs = data.vocabs.map((vocab: unknown) => {
      if (!isObject(vocab)) return vocab;
      const image = inline(vocab.id, vocab.imageUrl);
      if (image) vocabImages.push(image);
      if (!('imageUrl' in vocab)) return vocab;
      const { imageUrl: _vocabImageUrl, ...rest } = vocab;
      return rest;
    });
  }
  return { stored, itemImage: inline(data.id, data.imageUrl), vocabImages };
}

/** `value` with every object's keys sorted, so two JSON copies that differ only in key order serialize alike. */
export function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])]));
}

/** Whether two parsed JSON values hold the same content, whatever the order of their keys. */
export const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
