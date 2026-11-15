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
  getAllItems,
  getAllSentenceTexts,
  getItemById,
  getItemsAfterRevision,
  softDeleteItem,
  storeItemImage,
  touchItemRevisions,
  upsertItem,
  upsertMany,
  type RevisionCursor,
  type UpsertOptions,
  type UpsertResult,
} from './db/items.js';
export {
  applyReviewEvent,
  getReviewEvents,
  getReviewHistory,
  undoReviewEvent,
  type AppliedReviewResult,
  type ReviewEventRow,
  type ReviewHistoryRows,
  type UndoneReviewResult,
} from './db/reviews.js';
export {
  createSession,
  createUserAndClaimItems,
  deleteSession,
  findUserByGoogleId,
  getSessionUser,
  getUserCount,
  listAllUsers,
  type UserRow,
} from './db/users.js';
export { getComparisons, upsertComparison, type StoredComparisonRow } from './db/comparisons.js';
export { migrateLegacyProjects } from './db/legacy-projects.js';
