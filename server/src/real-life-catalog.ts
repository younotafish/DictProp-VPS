import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface RawSentence {
  text: string;
  focus: string;
}

interface RawSection {
  id: string;
  title: string;
  description: string;
  sentences: RawSentence[];
}

interface RawCollection {
  id: string;
  title: string;
  eyebrow: string;
  description: string;
  level: string;
  accent: string;
  sections: RawSection[];
}

interface RawCatalog {
  version: number;
  collections: RawCollection[];
}

export interface RealLifeCatalogSentence extends RawSentence {
  id: string;
  collectionId: string;
  collectionTitle: string;
  sectionId: string;
  sectionTitle: string;
}

export interface RealLifeCatalogSummary {
  id: string;
  title: string;
  sentenceCount: number;
  sectionCount: number;
}

function readCatalog(): RawCatalog {
  const path = fileURLToPath(new URL('../../content/real-life-catalog.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as RawCatalog;
}

function buildCatalog(source: RawCatalog): {
  byId: Map<string, RealLifeCatalogSentence>;
  summaries: RealLifeCatalogSummary[];
} {
  if (source.version !== 1 || !Array.isArray(source.collections) || source.collections.length === 0) {
    throw new Error('Real Life catalog must contain version 1 collections');
  }

  const byId = new Map<string, RealLifeCatalogSentence>();
  const summaries: RealLifeCatalogSummary[] = [];
  const collectionIds = new Set<string>();

  for (const collection of source.collections) {
    if (!collection?.id || !collection.title || !Array.isArray(collection.sections) ||
        collectionIds.has(collection.id)) {
      throw new Error(`Real Life catalog contains an invalid collection: ${collection?.id || 'unknown'}`);
    }
    collectionIds.add(collection.id);
    const sectionIds = new Set<string>();
    let sentenceCount = 0;

    for (const section of collection.sections) {
      if (!section?.id || !section.title || !Array.isArray(section.sentences) ||
          sectionIds.has(section.id)) {
        throw new Error(`Real Life catalog contains an invalid section: ${section?.id || 'unknown'}`);
      }
      sectionIds.add(section.id);
      section.sentences.forEach((sentence, index) => {
        if (typeof sentence?.text !== 'string' || !sentence.text.trim() || sentence.text.length > 2_000 ||
            typeof sentence.focus !== 'string' || !sentence.focus.trim() ||
            !sentence.text.toLocaleLowerCase('en-US').includes(sentence.focus.toLocaleLowerCase('en-US'))) {
          throw new Error(`${collection.id}/${section.id} contains an invalid sentence at index ${index}`);
        }
        const id = `${collection.id}:${section.id}:${String(index + 1).padStart(2, '0')}`;
        if (byId.has(id)) throw new Error(`Real Life catalog duplicates sentence id ${id}`);
        byId.set(id, {
          ...sentence,
          id,
          collectionId: collection.id,
          collectionTitle: collection.title,
          sectionId: section.id,
          sectionTitle: section.title,
        });
        sentenceCount += 1;
      });
    }

    if (sentenceCount < 200) {
      throw new Error(`Real Life collection ${collection.id} must contain at least 200 sentences`);
    }
    summaries.push({
      id: collection.id,
      title: collection.title,
      sentenceCount,
      sectionCount: collection.sections.length,
    });
  }

  return { byId, summaries };
}

const catalog = buildCatalog(readCatalog());

export function getRealLifeCatalogSentence(id: string): RealLifeCatalogSentence | undefined {
  return catalog.byId.get(id);
}

export function getRealLifeCatalogSummaries(): readonly RealLifeCatalogSummary[] {
  return catalog.summaries;
}

export function getRealLifeCatalogSentenceCount(): number {
  return catalog.byId.size;
}

export function getAllRealLifeCatalogSentenceTexts(): string[] {
  return Array.from(catalog.byId.values(), sentence => sentence.text);
}
