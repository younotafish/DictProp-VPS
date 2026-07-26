import { createHash } from 'crypto';
import { getAllItems, listAllUsers } from '../db.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';
import { hasSentenceGrammarAnalysis, isSentenceAnalysis } from '../sentence-analysis.js';
import type { SentenceExportRecord } from '../sentence-backfill.js';

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const sentences: SentenceExportRecord[] = getAllItems(true, owner.id)
  .filter(item => item.type === 'sentence' && !item.isDeleted)
  .map(item => {
    const data = item.data as any;
    const text = typeof data.text === 'string' ? data.text : '';
    return {
      id: data.id,
      text,
      sourceWord: typeof data.sourceWord === 'string' ? data.sourceWord : '',
      ...(typeof data.sourceSense === 'string' ? { sourceSense: data.sourceSense } : {}),
      textHash: createHash('sha256').update(text).digest('hex'),
      hasAnalysis: isSentenceAnalysis(data.analysis),
      hasGrammar: hasSentenceGrammarAnalysis(data.analysis),
      hasImage: data.imageUrl?.startsWith('server:has_image') ||
        (typeof data.imageUrl === 'string' && data.imageUrl.startsWith('data:image/')),
    };
  });

process.stdout.write(JSON.stringify({ version: 1, exportedAt: Date.now(), sentences }));
