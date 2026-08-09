import catalogSource from '../content/essay-catalog.json';

export type EssayAccent = 'indigo' | 'amber' | 'violet' | 'rose' | 'emerald';

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

type RawEssayParagraph = RawEssayBodyParagraph | RawEssayEpigraph;

interface RawEssay {
  id: string;
  title: string;
  author: string;
  year: number;
  publication: string;
  eyebrow: string;
  description: string;
  level: string;
  accent: EssayAccent;
  themes: string[];
  modernityNote: string;
  sourceLabel: string;
  sourceUrl: string;
  publicDomainNote: string;
  wordCount: number;
  readingMinutes: number;
  sentenceCount: number;
  paragraphs: RawEssayParagraph[];
}

interface RawEssayCatalog {
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

export interface Essay extends Omit<RawEssay, 'paragraphs'> {
  paragraphs: EssayParagraph[];
  sentences: EssaySentence[];
}

function markFocus(text: string, focus: string): string {
  const index = text.toLocaleLowerCase('en-US').indexOf(focus.toLocaleLowerCase('en-US'));
  if (index < 0) return text;
  return `${text.slice(0, index)}{{${text.slice(index, index + focus.length)}}}${text.slice(index + focus.length)}`;
}

function buildCatalog(source: RawEssayCatalog): Essay[] {
  if (source.version !== 1 || !Array.isArray(source.essays) || source.essays.length !== 5) {
    throw new Error('Essay catalog must contain five version 1 essays');
  }

  return source.essays.map(essay => {
    let position = 0;
    const paragraphs: EssayParagraph[] = essay.paragraphs.map(paragraph => {
      if (paragraph.kind === 'epigraph') return paragraph;
      return {
        ...paragraph,
        sentences: paragraph.sentences.map(sentence => {
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
    return { ...essay, paragraphs, sentences };
  });
}

export const ESSAYS = buildCatalog(catalogSource as RawEssayCatalog);

const SENTENCES_BY_ID = new Map(
  ESSAYS.flatMap(essay => essay.sentences).map(sentence => [sentence.id, sentence]),
);

export function findEssaySentence(id: string): EssaySentence | undefined {
  return SENTENCES_BY_ID.get(id);
}

export function findEssay(id: string): Essay | undefined {
  return ESSAYS.find(essay => essay.id === id);
}
