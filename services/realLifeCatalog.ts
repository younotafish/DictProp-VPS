import catalogSource from '../content/real-life-catalog.json';

export type RealLifeAccent = 'indigo' | 'emerald' | 'amber';

interface RealLifeSourceLink {
  label: string;
  url: string;
}

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
  accent: RealLifeAccent;
  sourceNote?: string;
  sourceLinks?: RealLifeSourceLink[];
  sections: RawSection[];
}

interface RawCatalog {
  version: 1;
  collections: RawCollection[];
}

export interface RealLifeSentence {
  id: string;
  collectionId: string;
  collectionTitle: string;
  sectionId: string;
  sectionTitle: string;
  text: string;
  markedText: string;
  focus: string;
  position: number;
}

export interface RealLifeSection extends Omit<RawSection, 'sentences'> {
  sentences: RealLifeSentence[];
}

export interface RealLifeCollection extends Omit<RawCollection, 'sections'> {
  sections: RealLifeSection[];
  sentences: RealLifeSentence[];
}

function markFocus(text: string, focus: string): string {
  const index = text.toLocaleLowerCase('en-US').indexOf(focus.toLocaleLowerCase('en-US'));
  if (index < 0) return text;
  return `${text.slice(0, index)}{{${text.slice(index, index + focus.length)}}}${text.slice(index + focus.length)}`;
}

function buildCatalog(source: RawCatalog): RealLifeCollection[] {
  if (source.version !== 1 || !Array.isArray(source.collections)) {
    throw new Error('Real Life catalog is invalid');
  }

  return source.collections.map(collection => {
    let position = 0;
    const sections = collection.sections.map(section => ({
      ...section,
      sentences: section.sentences.map((sentence, index) => {
        position += 1;
        return {
          id: `${collection.id}:${section.id}:${String(index + 1).padStart(2, '0')}`,
          collectionId: collection.id,
          collectionTitle: collection.title,
          sectionId: section.id,
          sectionTitle: section.title,
          text: sentence.text,
          markedText: markFocus(sentence.text, sentence.focus),
          focus: sentence.focus,
          position,
        };
      }),
    }));

    return {
      ...collection,
      sections,
      sentences: sections.flatMap(section => section.sentences),
    };
  });
}

export const REAL_LIFE_COLLECTIONS = buildCatalog(catalogSource as RawCatalog);

const SENTENCES_BY_ID = new Map(
  REAL_LIFE_COLLECTIONS.flatMap(collection => collection.sentences).map(sentence => [sentence.id, sentence]),
);

export function findRealLifeSentence(id: string): RealLifeSentence | undefined {
  return SENTENCES_BY_ID.get(id);
}
