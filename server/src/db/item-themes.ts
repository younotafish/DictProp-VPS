import { themeInput, type ThemeItem } from '../themes/input.js';
import { db, writeTransaction } from './connection.js';

// Today's themes: a row for each saved word and sentence the classifier has read (schema.ts), the changes clients pull,
// and what the theme sweep (themes/sweep.ts) reads and records.

/** Misses on the same input, under the same taxonomy, after which the classifier stops asking about an item. */
export const MAX_THEME_FAILURES = 3;

const CANDIDATE_CHUNK = 500;

export const themeStmts = {
  headSeq: db.prepare(`SELECT value FROM sync_meta WHERE key = 'theme_seq'`).pluck(),
  nextSeq: db.prepare(`UPDATE sync_meta SET value = value + 1 WHERE key = 'theme_seq' RETURNING value`).pluck(),
  changedAfter: db.prepare(`SELECT item_id, theme_id FROM item_themes
    WHERE user_id = ? AND seq > ? AND seq <= ? ORDER BY seq`),
  row: db.prepare(`SELECT theme_id, input_hash, taxonomy_version, failures, seq FROM item_themes
    WHERE user_id = ? AND item_id = ?`),
  upsert: db.prepare(`INSERT INTO item_themes
    (user_id, item_id, theme_id, input_hash, taxonomy_version, model, classified_at, failures, seq)
    VALUES (@user_id, @item_id, @theme_id, @input_hash, @taxonomy_version, @model, @classified_at, @failures, @seq)
    ON CONFLICT (user_id, item_id) DO UPDATE SET theme_id = excluded.theme_id, input_hash = excluded.input_hash,
      taxonomy_version = excluded.taxonomy_version, model = excluded.model, classified_at = excluded.classified_at,
      failures = excluded.failures, seq = excluded.seq`),
  // The live items the classifier reads, a chunk at a time in rowid order, with only the fields it needs taken out of
  // their JSON, beside each one's theme row. Words, and the user's own sentences: catalog lines are out of Today, the
  // first Real Life ones without a catalogKind, so their ids rule them out too. NOT INDEXED keeps the walk on rowid:
  // without planner statistics SQLite would take the (user_id, type) index and sort every remaining row, its JSON read
  // and all, for each chunk.
  candidates: db.prepare(`SELECT items.rowid AS row_id, items.id AS item_id, items.type, items.saved_at,
      json_extract(items.data, '$.word') AS word, json_extract(items.data, '$.sense') AS sense,
      json_extract(items.data, '$.definition') AS definition, json_extract(items.data, '$.text') AS text,
      json_extract(items.srs, '$.totalReviews') AS total_reviews,
      themes.theme_id, themes.input_hash, themes.taxonomy_version, themes.failures
    FROM items NOT INDEXED LEFT JOIN item_themes AS themes ON themes.user_id = items.user_id AND themes.item_id = items.id
    WHERE items.user_id = ? AND items.rowid > ? AND items.is_deleted IS NOT 1 AND items.is_archived IS NOT 1
      AND (items.type = 'vocab' OR (items.type = 'sentence' AND json_extract(items.data, '$.catalogKind') IS NULL
        AND items.id NOT LIKE 'real-life-sentence:%' AND items.id NOT LIKE 'essay-sentence:%'))
    ORDER BY items.rowid LIMIT ?`),
};

/** What a theme row says about an item. */
interface ThemeRowState {
  theme_id: string | null;
  input_hash: string;
  taxonomy_version: number;
  failures: number;
  seq: number;
}

/** A theme row as needsTheme reads it: every field null for an item without one. */
export type ThemeRowFields = { [K in 'theme_id' | 'input_hash' | 'taxonomy_version' | 'failures']: ThemeRowState[K] | null };

interface CandidateRow extends ThemeRowFields {
  row_id: number;
  item_id: string;
  type: string;
  saved_at: number;
  word: unknown;
  sense: unknown;
  definition: unknown;
  text: unknown;
  total_reviews: unknown;
}

/** The theme rows of a user that changed after `after`, in seq order, as GET /api/themes sends them. */
export interface ThemeRowChanges {
  /** [itemId, themeId]; a null theme means the item has none any more. */
  rows: Array<[string, string | null]>;
  /** The newest seq issued: the one to ask after next time. */
  latestSeq: number;
}

/**
 * The user's theme rows changed after `after`: from 0, every row with a theme, since there is nothing yet to take one
 * away from. Rows stop at the newest seq read first, so a change committing meanwhile isn't skipped next time.
 */
export function getThemeRowsAfter(userId: string, after: number): ThemeRowChanges {
  const latestSeq = themeStmts.headSeq.get() as number;
  const rows = (themeStmts.changedAfter.all(userId, after, latestSeq) as Array<{ item_id: string; theme_id: string | null }>)
    .filter(row => after > 0 || row.theme_id !== null);
  return { rows: rows.map(row => [row.item_id, row.theme_id]), latestSeq };
}

/** An item the classifier is to read, with its input. */
export interface ThemeCandidate {
  itemId: string;
  item: ThemeItem;
  inputHash: string;
  /** Never reviewed: what Today's sets are made of, so labelled first. */
  isNew: boolean;
  savedAt: number;
}

/**
 * Whether an item needs the classifier: it has no row, its input changed, or it has no theme the taxonomy still holds
 * and the classifier hasn't yet missed it MAX_THEME_FAILURES times on this input and taxonomy. A theme the taxonomy
 * still holds stays when the taxonomy changes, so a new version labels again only the items whose theme left it.
 */
export function needsTheme(
  row: ThemeRowFields,
  inputHash: string,
  taxonomyVersion: number,
  themeIds: ReadonlySet<string>,
): boolean {
  if (row.input_hash !== inputHash) return true;
  if (row.theme_id && themeIds.has(row.theme_id)) return false;
  return (row.taxonomy_version ?? 0) < taxonomyVersion || (row.failures ?? 0) < MAX_THEME_FAILURES;
}

/** Hands the event loop a turn, so a long read lets requests in between its chunks. */
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * The user's items that need the classifier (needsTheme), new ones first, each group newest saved first. The items are
 * read a chunk at a time, each chunk its own statement run to its end: an open statement would keep every write
 * waiting, and the gaps between chunks let requests in.
 */
export async function listThemeCandidates(
  userId: string,
  taxonomyVersion: number,
  themeIds: ReadonlySet<string>,
): Promise<ThemeCandidate[]> {
  const candidates: ThemeCandidate[] = [];
  for (let lastRowId = 0; ;) {
    const rows = themeStmts.candidates.all(userId, lastRowId, CANDIDATE_CHUNK) as CandidateRow[];
    if (rows.length === 0) break;
    lastRowId = rows[rows.length - 1].row_id;
    for (const row of rows) {
      const input = themeInput(row);
      if (!input || !needsTheme(row, input.inputHash, taxonomyVersion, themeIds)) continue;
      candidates.push({
        itemId: row.item_id, ...input, isNew: !(Number(row.total_reviews) > 0), savedAt: Number(row.saved_at) || 0,
      });
    }
    await nextTurn();
  }
  return candidates.sort((a, b) =>
    Number(b.isNew) - Number(a.isNew) || b.savedAt - a.savedAt || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

/** What the classifier made of one item: the theme it chose, or null when it gave none it could use. */
export interface ThemeResult {
  itemId: string;
  inputHash: string;
  themeId: string | null;
}

/**
 * Stores a batch's results. A theme replaces the row's and clears its misses; a miss counts against the input and
 * taxonomy it was made on (a new input or taxonomy starts the count again) and leaves the item with no theme, since one
 * chosen for an earlier input no longer describes it. seq moves only when the theme changes. Returns how many items
 * this batch left at MAX_THEME_FAILURES, which the classifier won't ask about again.
 */
export const recordThemeResults = writeTransaction((
  userId: string,
  results: readonly ThemeResult[],
  context: { model: string; taxonomyVersion: number; now: number },
): { exhausted: number } => {
  let exhausted = 0;
  for (const { itemId, inputHash, themeId } of results) {
    const row = themeStmts.row.get(userId, itemId) as ThemeRowState | undefined;
    const sameInput = row?.input_hash === inputHash && row.taxonomy_version === context.taxonomyVersion;
    const failures = themeId === null ? (sameInput ? row.failures : 0) + 1 : 0;
    const seq = (row?.theme_id ?? null) === themeId ? row?.seq ?? 0 : themeStmts.nextSeq.get() as number;
    themeStmts.upsert.run({
      user_id: userId, item_id: itemId, theme_id: themeId, input_hash: inputHash, taxonomy_version: context.taxonomyVersion,
      model: context.model, classified_at: context.now, failures, seq,
    });
    if (failures === MAX_THEME_FAILURES) exhausted++;
  }
  return { exhausted };
});
