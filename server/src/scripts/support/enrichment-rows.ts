import { db } from '../../db.js';
import type { StoredSentenceEnrichmentRecord } from '../../example-enrichment-coverage.js';

/**
 * Every stored example enrichment, streamed: the analyses run to several kilobytes apiece, tens of thousands of them.
 * An image's size is length(data), which SQLite reads from the blob row's header; byte_length sits after the blob,
 * and reaching it would read every page of every image.
 */
export function storedEnrichmentRows({ byLookupHash = false } = {}): Iterable<StoredSentenceEnrichmentRecord> {
  return db.prepare(`
    SELECT e.lookup_hash, e.analysis, e.image_content_hash, length(b.data) AS image_bytes, e.updated_at
    FROM sentence_enrichments e
    LEFT JOIN image_blobs b ON b.content_hash = e.image_content_hash
    ${byLookupHash ? 'ORDER BY e.lookup_hash' : ''}
  `).iterate() as Iterable<StoredSentenceEnrichmentRecord>;
}
