import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface RawEssaySentence {
  id: string;
  text: string;
  focus: string;
}

interface RawEssayBodyParagraph {
  kind: 'body';
  id: string;
  sentences: RawEssaySentence[];
}

interface RawEssayEpigraph {
  kind: 'epigraph';
  text: string;
}

interface RawEssay {
  id: string;
  title: string;
  author: string;
  sentenceCount: number;
  paragraphs: Array<RawEssayBodyParagraph | RawEssayEpigraph>;
}

interface RawEssayCatalog {
  version: number;
  essays: RawEssay[];
}

export interface EssayCatalogSentence extends RawEssaySentence {
  essayId: string;
  essayTitle: string;
  author: string;
  paragraphId: string;
}

export interface EssayCatalogSummary {
  id: string;
  title: string;
  author: string;
  sentenceCount: number;
}

function readCatalog(): RawEssayCatalog {
  const path = fileURLToPath(new URL('../../content/essay-catalog.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as RawEssayCatalog;
}

function buildCatalog(source: RawEssayCatalog): {
  byId: Map<string, EssayCatalogSentence>;
  summaries: EssayCatalogSummary[];
} {
  if (source.version !== 1 || !Array.isArray(source.essays) || source.essays.length !== 5) {
    throw new Error('Essay catalog must contain five version 1 essays');
  }

  const byId = new Map<string, EssayCatalogSentence>();
  const summaries: EssayCatalogSummary[] = [];
  const essayIds = new Set<string>();

  for (const essay of source.essays) {
    if (!essay?.id || !essay.title || !essay.author || !Array.isArray(essay.paragraphs) || essayIds.has(essay.id)) {
      throw new Error(`Essay catalog contains an invalid essay: ${essay?.id || 'unknown'}`);
    }
    essayIds.add(essay.id);
    let sentenceCount = 0;
    for (const paragraph of essay.paragraphs) {
      if (paragraph.kind === 'epigraph') {
        if (typeof paragraph.text !== 'string' || !paragraph.text.trim()) {
          throw new Error(`Essay ${essay.id} contains an invalid epigraph`);
        }
        continue;
      }
      if (paragraph.kind !== 'body' || !paragraph.id || !Array.isArray(paragraph.sentences)) {
        throw new Error(`Essay ${essay.id} contains an invalid paragraph`);
      }
      for (const sentence of paragraph.sentences) {
        if (!sentence?.id || typeof sentence.text !== 'string' || !sentence.text.trim() || sentence.text.length > 4_000 ||
            typeof sentence.focus !== 'string' || !sentence.focus.trim() ||
            !sentence.text.toLocaleLowerCase('en-US').includes(sentence.focus.toLocaleLowerCase('en-US')) ||
            byId.has(sentence.id)) {
          throw new Error(`Essay ${essay.id} contains an invalid sentence: ${sentence?.id || 'unknown'}`);
        }
        byId.set(sentence.id, {
          ...sentence,
          essayId: essay.id,
          essayTitle: essay.title,
          author: essay.author,
          paragraphId: paragraph.id,
        });
        sentenceCount += 1;
      }
    }
    if (sentenceCount !== essay.sentenceCount || sentenceCount === 0) {
      throw new Error(`Essay ${essay.id} sentence count mismatch: ${sentenceCount}/${essay.sentenceCount}`);
    }
    summaries.push({
      id: essay.id,
      title: essay.title,
      author: essay.author,
      sentenceCount,
    });
  }
  return { byId, summaries };
}

const catalog = buildCatalog(readCatalog());

export function getEssayCatalogSentence(id: string): EssayCatalogSentence | undefined {
  return catalog.byId.get(id);
}

export function getEssayCatalogSummaries(): readonly EssayCatalogSummary[] {
  return catalog.summaries;
}

export function getEssayCatalogSentenceCount(): number {
  return catalog.byId.size;
}

export function getAllEssayCatalogSentenceTexts(): string[] {
  return Array.from(catalog.byId.values(), sentence => sentence.text);
}
