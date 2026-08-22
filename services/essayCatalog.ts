import catalogSource from '../content/essay-catalog.json';

export type EssayAccent = 'indigo' | 'amber' | 'violet' | 'rose' | 'emerald';
export type EssayCollection = 'classic' | 'modern';

export interface RawEssaySentence {
  id: string;
  text: string;
  focus: string;
}

export interface RawEssayBodyParagraph {
  kind: 'body';
  id: string;
  sentences: RawEssaySentence[];
}

export interface RawEssayEpigraph {
  kind: 'epigraph';
  text: string;
}

export type RawEssayParagraph = RawEssayBodyParagraph | RawEssayEpigraph;

export interface RawEssay {
  id: string;
  title: string;
  author: string;
  year: number;
  publication: string;
  eyebrow: string;
  description: string;
  level: string;
  accent: EssayAccent;
  collection?: EssayCollection;
  themes: string[];
  modernityNote: string;
  sourceLabel: string;
  sourceUrl: string;
  publicDomainNote: string;
  rightsNote?: string;
  wordCount: number;
  readingMinutes: number;
  sentenceCount: number;
  paragraphs: RawEssayParagraph[];
}

export interface RawEssayCatalog {
  version: 1;
  generatedAt: string;
  editorialNote: string;
  essays: RawEssay[];
}

export interface EssaySentence extends RawEssaySentence {
  essayId: string;
  essayTitle: string;
  author: string;
  paragraphId: string;
  markedText: string;
  position: number;
}

export interface EssayBodyParagraph {
  kind: 'body';
  id: string;
  sentences: EssaySentence[];
}

export interface EssayEpigraph {
  kind: 'epigraph';
  text: string;
}

export type EssayParagraph = EssayBodyParagraph | EssayEpigraph;

export interface Essay extends Omit<RawEssay, 'collection' | 'paragraphs'> {
  collection: EssayCollection;
  paragraphs: EssayParagraph[];
  sentences: EssaySentence[];
}

function markFocus(text: string, focus: string): string {
  const index = text.toLocaleLowerCase('en-US').indexOf(focus.toLocaleLowerCase('en-US'));
  if (index < 0) return text;
  return `${text.slice(0, index)}{{${text.slice(index, index + focus.length)}}}${text.slice(index + focus.length)}`;
}

function buildCatalog(
  source: RawEssayCatalog,
  options: { expectedCount?: number; allowEmpty?: boolean; defaultCollection?: EssayCollection } = {},
): Essay[] {
  if (source.version !== 1 || !Array.isArray(source.essays)) {
    throw new Error('Essay catalog must be a version 1 catalog');
  }
  if (options.expectedCount !== undefined && source.essays.length !== options.expectedCount) {
    throw new Error(`Essay catalog must contain ${options.expectedCount} essays`);
  }
  if (!options.allowEmpty && source.essays.length === 0) {
    throw new Error('Essay catalog must contain at least one essay');
  }
  if (source.essays.length > 100) throw new Error('Essay catalog contains too many essays');

  const essayIds = new Set<string>();
  const sentenceIds = new Set<string>();
  return source.essays.map(essay => {
    if (!essay?.id || essayIds.has(essay.id) || !Array.isArray(essay.paragraphs)) {
      throw new Error(`Essay catalog contains an invalid essay: ${essay?.id || 'unknown'}`);
    }
    essayIds.add(essay.id);
    let position = 0;
    const paragraphs: EssayParagraph[] = essay.paragraphs.map(paragraph => {
      if (paragraph.kind === 'epigraph') return paragraph;
      if (!paragraph.id || !Array.isArray(paragraph.sentences)) {
        throw new Error(`Essay ${essay.id} contains an invalid paragraph`);
      }
      return {
        ...paragraph,
        sentences: paragraph.sentences.map(sentence => {
          if (!sentence?.id || sentenceIds.has(sentence.id) || !sentence.text?.trim() || !sentence.focus?.trim() ||
              !sentence.text.toLocaleLowerCase('en-US').includes(sentence.focus.toLocaleLowerCase('en-US'))) {
            throw new Error(`Essay ${essay.id} contains an invalid sentence: ${sentence?.id || 'unknown'}`);
          }
          sentenceIds.add(sentence.id);
          position += 1;
          return {
            ...sentence,
            essayId: essay.id,
            essayTitle: essay.title,
            author: essay.author,
            paragraphId: paragraph.id,
            markedText: markFocus(sentence.text, sentence.focus),
            position,
          };
        }),
      };
    });
    const sentences = paragraphs.flatMap(paragraph => paragraph.kind === 'body' ? paragraph.sentences : []);
    if (sentences.length !== essay.sentenceCount) {
      throw new Error(`Essay ${essay.id} declares ${essay.sentenceCount} sentences but contains ${sentences.length}`);
    }
    return {
      ...essay,
      collection: essay.collection ?? options.defaultCollection ?? 'classic',
      paragraphs,
      sentences,
    };
  });
}

const STATIC_ESSAYS = buildCatalog(catalogSource as RawEssayCatalog, {
  expectedCount: 5,
  defaultCollection: 'classic',
});
const STATIC_ESSAY_IDS = new Set(STATIC_ESSAYS.map(essay => essay.id));
const STATIC_SENTENCE_IDS = new Set(STATIC_ESSAYS.flatMap(essay => essay.sentences.map(sentence => sentence.id)));

// Mutated only by installPrivateEssayCatalog after the authenticated catalog request completes.
// Keeping the exported array stable lets progress helpers resolve newly installed sentence ids.
export const ESSAYS: Essay[] = [...STATIC_ESSAYS];

let sentencesById = new Map(
  ESSAYS.flatMap(essay => essay.sentences).map(sentence => [sentence.id, sentence]),
);

function rebuildSentenceIndex(): void {
  sentencesById = new Map(
    ESSAYS.flatMap(essay => essay.sentences).map(sentence => [sentence.id, sentence]),
  );
}

export function installPrivateEssayCatalog(source: RawEssayCatalog): Essay[] {
  const privateEssays = buildCatalog(source, { allowEmpty: true, defaultCollection: 'modern' });
  for (const essay of privateEssays) {
    if (STATIC_ESSAY_IDS.has(essay.id)) throw new Error(`Private essay duplicates a public essay: ${essay.id}`);
    for (const sentence of essay.sentences) {
      if (STATIC_SENTENCE_IDS.has(sentence.id)) {
        throw new Error(`Private essay sentence duplicates a public sentence: ${sentence.id}`);
      }
    }
  }
  ESSAYS.splice(STATIC_ESSAYS.length, ESSAYS.length - STATIC_ESSAYS.length, ...privateEssays);
  rebuildSentenceIndex();
  return [...ESSAYS];
}

export function findEssaySentence(id: string): EssaySentence | undefined {
  return sentencesById.get(id);
}

export function findEssay(id: string): Essay | undefined {
  return ESSAYS.find(essay => essay.id === id);
}
