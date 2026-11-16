// Limits of POST /api/import that the client has to agree with, in one place for both sides.
// Like everything in server/src/shared it imports nothing (see README.md).

// The import's image phase as a whole: past it no picture starts and those still downloading are cut off, so slow
// picture hosts can't hold the cards and the reply past the client's wait, which is this plus a margin for the
// upload, the save and the reply (services/api/jsonImport.ts).
export const IMPORT_IMAGE_PHASE_MS = 8 * 60_000;
