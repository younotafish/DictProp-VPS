// The SQLite database, split by table group under db/. Importing it opens the database file and applies the
// schema, so only server code imports it: code the client also runs lives in server/src/shared instead.
export { db, isDatabaseReady, writeTransaction } from './db/connection.js';
export {
  deleteUnreferencedBlobs,
  getImageManifest,
  getItemImage,
  getItemImageBinary,
  getItemImagesBatch,
  hasItemImage,
  upsertItemImageBinary,
  type ImageStoreResult,
} from './db/images.js';
export {
  getSentenceEnrichmentCount,
  getSentenceEnrichmentForText,
  getSentenceEnrichmentImage,
  upsertSentenceEnrichment,
  type SentenceEnrichmentImportRecord,
  type SentenceEnrichmentImportResult,
} from './db/sentence-enrichments.js';
export {
  forEachItemChunk,
  getAllItems,
  getAllSentenceTexts,
  getItemById,
  getItemsAfterRevision,
  softDeleteItem,
  storeItemImage,
  touchItemRevisions,
  upsertItem,
  upsertMany,
  type ItemWrite,
  type RevisionCursor,
  type StoredItemData,
  type StoredItemRecord,
  type UpsertOptions,
  type UpsertResult,
} from './db/items.js';
export {
  applyReviewEvent,
  getReviewEvents,
  getReviewHistory,
  getSetDays,
  undoReviewEvent,
  type AppliedReviewResult,
  type ReviewEvent,
  type ReviewHistoryRows,
  type UndoneReviewResult,
} from './db/reviews.js';
export {
  createSession,
  createUserAndClaimItems,
  deleteSession,
  extendSession,
  findUserByGoogleId,
  getSession,
  getSessionUser,
  getUserCount,
  listAllUsers,
  type UserRow,
  type UserSession,
} from './db/users.js';
export { getComparisons, upsertComparison, type StoredComparisonRow } from './db/comparisons.js';
export {
  getThemeRowsAfter,
  listThemeCandidates,
  MAX_THEME_FAILURES,
  recordThemeResults,
  type ThemeCandidate,
  type ThemeResult,
  type ThemeRowChanges,
} from './db/item-themes.js';
