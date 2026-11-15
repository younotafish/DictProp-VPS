// A library in the test process's database, for the tests that run the exporters and audits against it. Each
// script opens the same file in a process of its own, as production runs them inside the app container.
import { spawnSync } from 'node:child_process';
import type { SentenceAnalysis } from '../../src/sentence-analysis.js';
import { srs } from './fixtures.js';
import { png, sha256 } from './fs.js';
import { SERVER_DIR } from './paths.js';

const { createUserAndClaimItems, db, upsertItem, upsertItemImageBinary, upsertSentenceEnrichment } =
  await import('../../src/db.js');
const { enrichmentId } = await import('../../src/example-enrichment-coverage.js');
const { sentenceLookupHash } = await import('../../src/sentence-enrichment.js');

export const OWNER_EMAIL = 'owner@example.com';

/** The owner's account: the first one, so an admin, whose email the scripts are given. */
export function createOwner(): { id: string } {
  return createUserAndClaimItems({ googleId: 'script-owner', email: OWNER_EMAIL, displayName: null, photoUrl: null });
}

export interface ItemFields {
  savedAt?: number;
  updatedAt?: number;
  isArchived?: boolean;
}

/** Saves an item under `id` (whatever id `data` carries) with a never-reviewed SRS record, as a client would. */
export function saveItem(ownerId: string, id: string, type: string, data: Record<string, unknown>, fields: ItemFields = {}) {
  const { savedAt = 1, updatedAt = 1_000, isArchived } = fields;
  upsertItem({ type, data: { ...data, id }, srs: srs(id, type), savedAt, updatedAt, ...(isArchived ? { isArchived } : {}) }, ownerId);
}

/** Stores a PNG for an item or a phrase's nested card. */
export function addItemImage(ownerId: string, id: string): void {
  if (!upsertItemImageBinary(id, png(id), 'image/png', ownerId)) throw new Error(`image ${id} was refused`);
}

/**
 * Stores an example sentence's enrichment through the importer's own path, with an image when given one. The
 * analysis is whatever the test needs, an incomplete one included.
 */
export function storeExample(text: string, analysis: unknown, image?: Buffer): void {
  const lookupHash = sentenceLookupHash(text);
  upsertSentenceEnrichment({
    entry: {
      id: enrichmentId(lookupHash), text, lookupHash, textHash: sha256(text), analysis: analysis as SentenceAnalysis, generatedAt: 10,
    },
    ...(image ? { image, mimeType: 'image/png' } : {}),
  });
}

/**
 * Writes an enrichment row directly, for rows no importer would write: a malformed analysis, an image reference
 * whose blob is gone. updatedAt defaults to now, as the importer's own writes do.
 */
export function storeRawExample(text: string, analysisText: string, imageContentHash: string | null, updatedAt = Date.now()): void {
  const lookupHash = sentenceLookupHash(text);
  db.prepare(`
    INSERT INTO sentence_enrichments (lookup_hash, source_id, text_hash, source_text, analysis, generated_at,
      image_content_hash, image_mime_type, updated_at)
    VALUES (?, ?, ?, ?, ?, 10, ?, ?, ?)
  `).run(lookupHash, enrichmentId(lookupHash), sha256(text), text, analysisText, imageContentHash,
    imageContentHash ? 'image/png' : null, updatedAt);
}

/** Writes an image blob directly, without the checks the importers apply (an empty blob, say). */
export function storeRawBlob(data: Buffer): string {
  const contentHash = sha256(data);
  db.prepare('INSERT INTO image_blobs (content_hash, data, byte_length, created_at) VALUES (?, ?, ?, 1)')
    .run(contentHash, data, data.length);
  return contentHash;
}

/**
 * Runs server/src/scripts/<name>.ts in its own process against this database and returns its exit status and raw
 * output. NODE_TEST_CONTEXT stays out, or the child would report to the test runner instead of running.
 */
export function runScript(name: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}) {
  const { NODE_TEST_CONTEXT: _testContext, ...parentEnv } = process.env;
  const child = spawnSync(process.execPath, ['--import', 'tsx', `src/scripts/${name}.ts`, ...args], {
    cwd: SERVER_DIR,
    env: { ...parentEnv, DATA_DIR: process.env.DATA_DIR, OWNER_GOOGLE_EMAIL: OWNER_EMAIL, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

/** The script's report: its last line of output, parsed. */
export const lastJsonLine = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1) || 'null');
