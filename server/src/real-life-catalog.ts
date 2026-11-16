import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface RawSentence {
  /** The line's own number in its section; services/realLifeCatalog.ts says how ids are kept stable. */
  id: string;
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

function readCatalog(): RawCatalog {
  const path = fileURLToPath(new URL('../../content/real-life-catalog.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as RawCatalog;
}

/** Checks the catalog and returns each line's text by its id, in catalog order. */
function buildCatalog(source: RawCatalog): Map<string, string> {
  if (source.version !== 1 || !Array.isArray(source.collections) || source.collections.length === 0) {
    throw new Error('Real Life catalog must contain version 1 collections');
  }

  const sentenceTexts = new Map<string, string>();
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
      const lineIds = new Set<string>();
      section.sentences.forEach((sentence, index) => {
        if (typeof sentence?.id !== 'string' || !sentence.id.trim() ||
            typeof sentence.text !== 'string' || !sentence.text.trim() || sentence.text.length > 2_000 ||
            typeof sentence.focus !== 'string' || !sentence.focus.trim() ||
            !sentence.text.toLocaleLowerCase('en-US').includes(sentence.focus.toLocaleLowerCase('en-US'))) {
          throw new Error(`${collection.id}/${section.id} contains an invalid sentence at index ${index}`);
        }
        if (lineIds.has(sentence.id)) throw new Error(`${collection.id}/${section.id} repeats sentence id ${sentence.id}`);
        lineIds.add(sentence.id);
        const id = `${collection.id}:${section.id}:${sentence.id}`;
        if (sentenceTexts.has(id)) throw new Error(`Real Life catalog duplicates sentence id ${id}`);
        sentenceTexts.set(id, sentence.text);
        sentenceCount += 1;
      });
    }

    if (sentenceCount < 200) {
      throw new Error(`Real Life collection ${collection.id} must contain at least 200 sentences`);
    }
  }

  return sentenceTexts;
}

const catalog = buildCatalog(readCatalog());

/** Every Real Life line's text, in catalog order. */
export function getAllRealLifeCatalogSentenceTexts(): string[] {
  return Array.from(catalog.values());
}
