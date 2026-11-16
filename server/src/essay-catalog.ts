import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

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
  paragraphs: Array<RawEssayBodyParagraph | RawEssayEpigraph>;
}

export interface RawEssayCatalog {
  version: 1;
  generatedAt: string;
  editorialNote: string;
  essays: RawEssay[];
}

interface BuiltCatalog {
  /** Each sentence's text, by sentence id, in reading order. */
  sentenceTexts: Map<string, string>;
  /** Its essays' ids, which a private catalog may not reuse. */
  essayIds: Set<string>;
}

const ACCENTS = new Set<EssayAccent>(['indigo', 'amber', 'violet', 'rose', 'emerald']);
const COLLECTIONS = new Set<EssayCollection>(['classic', 'modern']);
const PRIVATE_CATALOG_PATH = resolve(env.DATA_DIR, 'private-essay-catalog.json');
const EMPTY_PRIVATE_CATALOG: RawEssayCatalog = {
  version: 1,
  generatedAt: '',
  editorialNote: '',
  essays: [],
};

function readStaticCatalog(): RawEssayCatalog {
  const path = fileURLToPath(new URL('../../content/essay-catalog.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as RawEssayCatalog;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= maxLength;
}

function validSourceUrl(value: unknown): value is string {
  if (!validText(value, 2_000)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function buildCatalog(
  source: RawEssayCatalog,
  options: {
    expectedEssayCount?: number;
    allowEmpty?: boolean;
    requiredCollection?: EssayCollection;
    reservedEssayIds?: ReadonlySet<string>;
    reservedSentenceIds?: ReadonlySet<string>;
  } = {},
): BuiltCatalog {
  if (source?.version !== 1 || !Array.isArray(source.essays)) {
    throw new Error('Essay catalog must be a version 1 catalog');
  }
  if (options.expectedEssayCount !== undefined && source.essays.length !== options.expectedEssayCount) {
    throw new Error(`Essay catalog must contain ${options.expectedEssayCount} essays`);
  }
  if (!options.allowEmpty && source.essays.length === 0) {
    throw new Error('Essay catalog must contain at least one essay');
  }
  if (source.essays.length > 100) throw new Error('Essay catalog contains too many essays');
  if (typeof source.generatedAt !== 'string' || source.generatedAt.length > 100 ||
      typeof source.editorialNote !== 'string' || source.editorialNote.length > 4_000) {
    throw new Error('Essay catalog metadata is invalid');
  }

  const sentenceTexts = new Map<string, string>();
  const essayIds = new Set<string>();
  let totalSentences = 0;
  let totalTextBytes = 0;

  for (const essay of source.essays) {
    if (!essay || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(essay.id || '') ||
        !validText(essay.title, 500) || !validText(essay.author, 300) ||
        !Number.isInteger(essay.year) || essay.year < 1700 || essay.year > 2100 ||
        !validText(essay.publication, 1_000) || !validText(essay.eyebrow, 300) ||
        !validText(essay.description, 4_000) || !validText(essay.level, 100) ||
        !ACCENTS.has(essay.accent) || (essay.collection !== undefined && !COLLECTIONS.has(essay.collection)) ||
        (options.requiredCollection !== undefined && essay.collection !== options.requiredCollection) ||
        !Array.isArray(essay.themes) || essay.themes.length === 0 || essay.themes.length > 20 ||
        essay.themes.some(theme => !validText(theme, 200)) || !validText(essay.modernityNote, 4_000) ||
        !validText(essay.sourceLabel, 500) || !validSourceUrl(essay.sourceUrl) ||
        !validText(essay.publicDomainNote, 4_000) ||
        (essay.rightsNote !== undefined && !validText(essay.rightsNote, 4_000)) ||
        !Number.isInteger(essay.wordCount) || essay.wordCount < 1 ||
        !Number.isInteger(essay.readingMinutes) || essay.readingMinutes < 1 ||
        !Number.isInteger(essay.sentenceCount) || essay.sentenceCount < 1 ||
        !Array.isArray(essay.paragraphs) || essayIds.has(essay.id) ||
        options.reservedEssayIds?.has(essay.id)) {
      throw new Error(`Essay catalog contains an invalid essay: ${essay?.id || 'unknown'}`);
    }
    essayIds.add(essay.id);
    let sentenceCount = 0;
    const paragraphIds = new Set<string>();
    for (const paragraph of essay.paragraphs) {
      if (paragraph.kind === 'epigraph') {
        if (!validText(paragraph.text, 20_000)) {
          throw new Error(`Essay ${essay.id} contains an invalid epigraph`);
        }
        totalTextBytes += Buffer.byteLength(paragraph.text);
        continue;
      }
      if (paragraph.kind !== 'body' || !validText(paragraph.id, 200) ||
          paragraphIds.has(paragraph.id) || !Array.isArray(paragraph.sentences) ||
          paragraph.sentences.length === 0) {
        throw new Error(`Essay ${essay.id} contains an invalid paragraph`);
      }
      paragraphIds.add(paragraph.id);
      for (const sentence of paragraph.sentences) {
        if (!sentence || !validText(sentence.id, 250) || !sentence.id.startsWith(`${essay.id}:`) ||
            !validText(sentence.text, 4_000) || !validText(sentence.focus, 300) ||
            !sentence.text.toLocaleLowerCase('en-US').includes(sentence.focus.toLocaleLowerCase('en-US')) ||
            sentenceTexts.has(sentence.id) || options.reservedSentenceIds?.has(sentence.id)) {
          throw new Error(`Essay ${essay.id} contains an invalid sentence: ${sentence?.id || 'unknown'}`);
        }
        sentenceTexts.set(sentence.id, sentence.text);
        sentenceCount += 1;
        totalSentences += 1;
        totalTextBytes += Buffer.byteLength(sentence.text);
      }
    }
    if (sentenceCount !== essay.sentenceCount) {
      throw new Error(`Essay ${essay.id} sentence count mismatch: ${sentenceCount}/${essay.sentenceCount}`);
    }
  }
  if (totalSentences > 10_000 || totalTextBytes > 20 * 1024 * 1024) {
    throw new Error('Essay catalog exceeds the private catalog size limit');
  }
  return { sentenceTexts, essayIds };
}

const staticSource = readStaticCatalog();
const staticCatalog = buildCatalog(staticSource, { expectedEssayCount: 5 });
const staticEssayIds = staticCatalog.essayIds;
const staticSentenceIds = new Set(staticCatalog.sentenceTexts.keys());

let privateCache: {
  signature: string;
  source: RawEssayCatalog;
  catalog: BuiltCatalog;
} = {
  signature: 'missing',
  source: EMPTY_PRIVATE_CATALOG,
  catalog: { sentenceTexts: new Map(), essayIds: new Set() },
};

function loadPrivateCatalog(): typeof privateCache {
  let signature = 'missing';
  try {
    const stat = statSync(PRIVATE_CATALOG_PATH);
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) {
      throw new Error('Private essay catalog file is invalid');
    }
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (signature === privateCache.signature) return privateCache;
  if (signature === 'missing') {
    privateCache = {
      signature,
      source: EMPTY_PRIVATE_CATALOG,
      catalog: { sentenceTexts: new Map(), essayIds: new Set() },
    };
    return privateCache;
  }
  const source = JSON.parse(readFileSync(PRIVATE_CATALOG_PATH, 'utf8')) as RawEssayCatalog;
  const catalog = buildCatalog(source, {
    allowEmpty: true,
    requiredCollection: 'modern',
    reservedEssayIds: staticEssayIds,
    reservedSentenceIds: staticSentenceIds,
  });
  privateCache = { signature, source, catalog };
  return privateCache;
}

export function validatePrivateEssayCatalog(source: RawEssayCatalog): void {
  buildCatalog(source, {
    requiredCollection: 'modern',
    reservedEssayIds: staticEssayIds,
    reservedSentenceIds: staticSentenceIds,
  });
}

export function getPrivateEssayCatalog(): RawEssayCatalog {
  return loadPrivateCatalog().source;
}

/** Every essay sentence's text, the static essays' first and then the private ones', each in reading order. */
export function getAllEssayCatalogSentenceTexts(): string[] {
  return [...staticCatalog.sentenceTexts.values(), ...loadPrivateCatalog().catalog.sentenceTexts.values()];
}
