import { forEachItemChunk } from '../db.js';
import { hasCompleteSentenceAnalysis, hasSentenceGrammarAnalysis, isSentenceAnalysis } from '../sentence-analysis.js';
import type { SentenceExportRecord } from '../sentence-backfill.js';
import { sentenceTextHash } from '../sentence-lookup.js';
import { SERVER_IMAGE_MARKER } from '../shared/image-markers.js';
import { requireOwner } from './support/run.js';

const owner = requireOwner();

// Only the sentence rows are read, a chunk at a time. Their records are small, so the export is still one string.
const sentences: SentenceExportRecord[] = [];
await forEachItemChunk(owner.id, items => {
  for (const item of items) {
    if (item.isDeleted) continue;
    const data = item.data;
    const text = typeof data.text === 'string' ? data.text : '';
    sentences.push({
      id: data.id,
      text,
      sourceWord: typeof data.sourceWord === 'string' ? data.sourceWord : '',
      ...(typeof data.sourceSense === 'string' ? { sourceSense: data.sourceSense } : {}),
      textHash: sentenceTextHash(text),
      hasAnalysis: isSentenceAnalysis(data.analysis),
      hasGrammar: hasSentenceGrammarAnalysis(data.analysis),
      hasDetailedAnalysis: hasCompleteSentenceAnalysis(data.analysis),
      // Item data never holds image bytes: a write moves an inline image into item_images, and the read path gives
      // each image stored there a server:has_image marker.
      hasImage: typeof data.imageUrl === 'string' && data.imageUrl.startsWith(SERVER_IMAGE_MARKER),
    });
  }
}, { type: 'sentence' });

process.stdout.write(JSON.stringify({ version: 1, exportedAt: Date.now(), sentences }));
