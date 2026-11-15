import { createHash } from 'crypto';
import { hasImageSignature } from '../image-format.js';
import { hasCompleteSentenceAnalysis } from '../sentence-analysis.js';
import { sentenceLookupHash, type SentenceEnrichmentEntry } from '../sentence-enrichment.js';
import { db } from './connection.js';
import { deleteUnreferencedBlobs, imageStmts } from './images.js';

const sentenceEnrichmentStmts = {
  get: db.prepare(`SELECT * FROM sentence_enrichments WHERE lookup_hash = ?`),
  hasImage: db.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM sentence_enrichments e
      JOIN image_blobs b ON b.content_hash = e.image_content_hash
      WHERE e.lookup_hash = ? AND b.byte_length > 0
    ) AS has_image
  `),
  getImage: db.prepare(`
    SELECT b.data, e.image_mime_type
    FROM sentence_enrichments e
    JOIN image_blobs b ON b.content_hash = e.image_content_hash
    WHERE e.lookup_hash = ?
  `),
  count: db.prepare(`SELECT COUNT(*) AS count FROM sentence_enrichments`),
  attachImage: db.prepare(`
    UPDATE sentence_enrichments
    SET image_content_hash = @image_content_hash,
        image_mime_type = @image_mime_type,
        updated_at = @updated_at
    WHERE lookup_hash = @lookup_hash
  `),
  upsert: db.prepare(`
    INSERT INTO sentence_enrichments (
      lookup_hash, source_id, text_hash, source_text, analysis, generated_at,
      image_content_hash, image_mime_type, updated_at
    ) VALUES (
      @lookup_hash, @source_id, @text_hash, @source_text, @analysis, @generated_at,
      @image_content_hash, @image_mime_type, @updated_at
    )
    ON CONFLICT(lookup_hash) DO UPDATE SET
      source_id = excluded.source_id,
      text_hash = excluded.text_hash,
      source_text = excluded.source_text,
      analysis = excluded.analysis,
      generated_at = excluded.generated_at,
      image_content_hash = COALESCE(excluded.image_content_hash, sentence_enrichments.image_content_hash),
      image_mime_type = COALESCE(excluded.image_mime_type, sentence_enrichments.image_mime_type),
      updated_at = excluded.updated_at
    WHERE excluded.generated_at >= sentence_enrichments.generated_at
  `),
};

interface SentenceEnrichmentRow {
  lookup_hash: string;
  source_id: string;
  text_hash: string;
  source_text: string;
  analysis: string;
  generated_at: number;
  image_content_hash: string | null;
  image_mime_type: string | null;
  updated_at: number;
}

export interface SentenceEnrichmentImportRecord {
  entry: SentenceEnrichmentEntry;
  image?: Buffer;
  mimeType?: string;
}

export interface SentenceEnrichmentImportResult {
  status: 'inserted' | 'updated' | 'unchanged' | 'stale';
  imageStored: boolean;
}

export function getSentenceEnrichmentCount(): number {
  return (sentenceEnrichmentStmts.count.get() as { count: number }).count;
}

export function getSentenceEnrichmentForText(text: string): {
  analysis: any;
  generatedAt: number;
  imageContentHash: string | null;
  imageMimeType: string | null;
} | null {
  if (!text.trim()) return null;
  const row = sentenceEnrichmentStmts.get.get(sentenceLookupHash(text)) as SentenceEnrichmentRow | undefined;
  if (!row) return null;
  try {
    return {
      analysis: JSON.parse(row.analysis),
      generatedAt: row.generated_at,
      imageContentHash: row.image_content_hash,
      imageMimeType: row.image_mime_type,
    };
  } catch {
    return null;
  }
}

export function getSentenceEnrichmentImage(lookupHash: string): {
  data: Buffer;
  mimeType: string;
} | null {
  if (!/^[a-f0-9]{64}$/.test(lookupHash)) return null;
  const row = sentenceEnrichmentStmts.getImage.get(lookupHash) as {
    data: Buffer;
    image_mime_type: string;
  } | undefined;
  if (!row?.data || !/^image\/(?:avif|gif|jpeg|png|webp)$/.test(row.image_mime_type || '')) return null;
  return { data: row.data, mimeType: row.image_mime_type };
}

export function upsertSentenceEnrichment(record: SentenceEnrichmentImportRecord): SentenceEnrichmentImportResult {
  const { entry, image, mimeType } = record;
  const existing = sentenceEnrichmentStmts.get.get(entry.lookupHash) as SentenceEnrichmentRow | undefined;
  const existingHasImage = existing
    ? (sentenceEnrichmentStmts.hasImage.get(entry.lookupHash) as { has_image: number }).has_image === 1
    : false;
  let existingAnalysisComplete = false;
  if (existing) {
    try {
      existingAnalysisComplete = hasCompleteSentenceAnalysis(JSON.parse(existing.analysis));
    } catch {
      existingAnalysisComplete = false;
    }
  }
  const preserveExistingAnalysis = existingAnalysisComplete && !hasCompleteSentenceAnalysis(entry.analysis);
  const attachImageWithoutAnalysis = !!existing && !!image && !!mimeType && !existingHasImage &&
    (existing.generated_at > entry.generatedAt || preserveExistingAnalysis);
  if (existing && (existing.generated_at > entry.generatedAt || preserveExistingAnalysis) &&
      !attachImageWithoutAnalysis) {
    return { status: 'stale', imageStored: false };
  }

  let imageContentHash: string | null = existing?.image_content_hash ?? null;
  let imageMimeType: string | null = existing?.image_mime_type ?? null;
  let imageStored = false;
  if (image && mimeType) {
    if (image.length === 0 || !/^image\/(?:avif|gif|jpeg|png|webp)$/.test(mimeType) ||
        !hasImageSignature(image, mimeType)) {
      throw new Error(`Sentence enrichment ${entry.id} has an invalid image`);
    }
    imageContentHash = createHash('sha256').update(image).digest('hex');
    imageMimeType = mimeType;
    const inserted = imageStmts.upsertBlob.run({
      content_hash: imageContentHash,
      data: image,
      byte_length: image.length,
      created_at: entry.generatedAt,
    });
    imageStored = inserted.changes > 0;
  }

  // Media and analysis can finish in separate resumable waves. A verified late image may repair a
  // newer analysis row, but must never replace that row's text, analysis, or generation timestamp.
  if (attachImageWithoutAnalysis) {
    sentenceEnrichmentStmts.attachImage.run({
      lookup_hash: entry.lookupHash,
      image_content_hash: imageContentHash,
      image_mime_type: imageMimeType,
      updated_at: Date.now(),
    });
    if (existing.image_content_hash && existing.image_content_hash !== imageContentHash) {
      deleteUnreferencedBlobs([existing.image_content_hash]);
    }
    return { status: 'updated', imageStored };
  }

  const analysis = JSON.stringify(entry.analysis);
  const unchanged = !!existing && existing.source_id === entry.id && existing.text_hash === entry.textHash &&
    existing.source_text === entry.text && existing.analysis === analysis &&
    existing.generated_at === entry.generatedAt && existing.image_content_hash === imageContentHash &&
    existing.image_mime_type === imageMimeType;
  if (unchanged) return { status: 'unchanged', imageStored };

  sentenceEnrichmentStmts.upsert.run({
    lookup_hash: entry.lookupHash,
    source_id: entry.id,
    text_hash: entry.textHash,
    source_text: entry.text,
    analysis,
    generated_at: entry.generatedAt,
    image_content_hash: imageContentHash,
    image_mime_type: imageMimeType,
    updated_at: Date.now(),
  });
  if (existing?.image_content_hash && existing.image_content_hash !== imageContentHash) {
    deleteUnreferencedBlobs([existing.image_content_hash]);
  }
  return { status: existing ? 'updated' : 'inserted', imageStored };
}
