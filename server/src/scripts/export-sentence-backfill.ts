import { getAllItems } from '../db.js';
import { hasCompleteSentenceAnalysis, hasSentenceGrammarAnalysis, isSentenceAnalysis } from '../sentence-analysis.js';
import type { SentenceExportRecord } from '../sentence-backfill.js';
import { sentenceTextHash } from '../sentence-lookup.js';
import { requireOwner } from './support/run.js';

const owner = requireOwner();

const sentences: SentenceExportRecord[] = getAllItems(owner.id)
  .filter(item => item.type === 'sentence' && !item.isDeleted)
  .map(item => {
    const data = item.data as any;
    const text = typeof data.text === 'string' ? data.text : '';
    return {
      id: data.id,
      text,
      sourceWord: typeof data.sourceWord === 'string' ? data.sourceWord : '',
      ...(typeof data.sourceSense === 'string' ? { sourceSense: data.sourceSense } : {}),
      textHash: sentenceTextHash(text),
      hasAnalysis: isSentenceAnalysis(data.analysis),
      hasGrammar: hasSentenceGrammarAnalysis(data.analysis),
      hasDetailedAnalysis: hasCompleteSentenceAnalysis(data.analysis),
      hasImage: data.imageUrl?.startsWith('server:has_image') ||
        (typeof data.imageUrl === 'string' && data.imageUrl.startsWith('data:image/')),
    };
  });

process.stdout.write(JSON.stringify({ version: 1, exportedAt: Date.now(), sentences }));
