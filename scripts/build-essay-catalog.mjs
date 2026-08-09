#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const outputPath = resolve(process.argv[2] || 'content/essay-catalog.json');
const segmenter = new Intl.Segmenter('en-US', { granularity: 'sentence' });

const sourceSpecs = {
  emerson: {
    url: 'https://www.gutenberg.org/cache/epub/16643/pg16643.txt',
    sha256: 'bd1e8cd9feb2c331b560dbb254cde873cb3db4b5d5464996d98f6e43649ad1e1',
  },
  twain: {
    url: 'https://www.gutenberg.org/files/68604/68604-0.txt',
    sha256: 'c5991c884b3bb7c7d1db006760ab225d9c2daee7843527621bfb27f86e203207',
  },
  dubois: {
    url: 'https://www.gutenberg.org/files/408/408-0.txt',
    sha256: '8c21eaa84331b3c1087c3845bfeeb5358be0f06f2b6cc2b3d882aff7e5fb9575',
  },
  gilman: {
    url: 'https://ic.media.mit.edu/people/davet/yp/whyiwrote.html',
    sha256: 'adccd022b0b18fb9dd0f981d1509a306e1ac346949036a8075ebd0c850a25fc5',
  },
  hurston: {
    url: 'https://www.gutenberg.org/cache/epub/73549/pg73549.txt',
    sha256: '52374c31d8ca439d512cc318a5fe5fb6389d4d168eee705c032fd47a6591170b',
  },
};

const essayMetadata = {
  'self-reliance': {
    title: 'Self-Reliance',
    author: 'Ralph Waldo Emerson',
    year: 1841,
    publication: 'Essays: First Series (1841)',
    eyebrow: 'Individualism & conviction',
    description: 'The defining American argument for trusting one’s own judgment instead of borrowing a life from convention.',
    level: 'C2 · historic diction',
    accent: 'indigo',
    themes: ['independent thought', 'nonconformity', 'character'],
    modernityNote: 'The syntax is the oldest and most demanding in this collection; its core vocabulary and argument remain central to modern American culture.',
    sourceLabel: 'Project Gutenberg · Essays',
    sourceUrl: sourceSpecs.emerson.url,
  },
  'corn-pone-opinions': {
    title: 'Corn-Pone Opinions',
    author: 'Mark Twain',
    year: 1923,
    publication: 'Written circa 1900; published in Europe and Elsewhere (1923)',
    eyebrow: 'Conformity & public opinion',
    description: 'A conversational, darkly funny account of how approval, fashion, and group loyalty quietly manufacture our opinions.',
    level: 'C1–C2',
    accent: 'amber',
    themes: ['conformity', 'social approval', 'politics'],
    modernityNote: 'Twain’s direct voice is highly readable today; one quoted passage preserves the historical dialect printed in the source.',
    sourceLabel: 'Project Gutenberg · Europe and Elsewhere',
    sourceUrl: sourceSpecs.twain.url,
  },
  'spiritual-strivings': {
    title: 'Of Our Spiritual Strivings',
    author: 'W. E. B. Du Bois',
    year: 1903,
    publication: 'The Souls of Black Folk (1903)',
    eyebrow: 'Identity & double consciousness',
    description: 'Du Bois names double consciousness and examines the unfinished struggle to be fully Black and fully American.',
    level: 'C2',
    accent: 'violet',
    themes: ['double consciousness', 'freedom', 'American identity'],
    modernityNote: 'The ideas and much of the prose remain strikingly current, while several long periodic sentences reward slower C2 reading.',
    sourceLabel: 'Project Gutenberg · The Souls of Black Folk',
    sourceUrl: sourceSpecs.dubois.url,
  },
  'why-i-wrote-the-yellow-wallpaper': {
    title: 'Why I Wrote “The Yellow Wallpaper”',
    author: 'Charlotte Perkins Gilman',
    year: 1913,
    publication: 'The Forerunner (October 1913)',
    eyebrow: 'Writing, medicine & agency',
    description: 'Gilman explains how harmful medical advice became a story—and how that story helped change treatment.',
    level: 'C1',
    accent: 'rose',
    themes: ['creative purpose', 'mental health', 'women’s agency'],
    modernityNote: 'This is the shortest and most immediately modern-sounding essay in the set.',
    sourceLabel: 'MIT Media Lab transcription · The Forerunner',
    sourceUrl: sourceSpecs.gilman.url,
  },
  'how-it-feels-to-be-colored-me': {
    title: 'How It Feels to Be Colored Me',
    author: 'Zora Neale Hurston',
    year: 1928,
    publication: 'The World Tomorrow (May 1928)',
    eyebrow: 'Voice, race & self-possession',
    description: 'Hurston’s vivid, rhythmically modern meditation refuses a tragic script and insists on a self larger than category.',
    level: 'C1–C2',
    accent: 'emerald',
    themes: ['identity', 'voice', 'self-possession'],
    modernityNote: 'The voice is energetic and recognizably modern; the essay retains the racial terminology of its 1928 publication.',
    sourceLabel: 'Project Gutenberg · How It Feels to Be Colored Me',
    sourceUrl: sourceSpecs.hurston.url,
  },
};

const stopWords = new Set(`a an and are as at be been being but by can could did do does doing for from had has have having he her hers him his how i if in into is it its may me might more most must my no nor not of on one or our ours she should so some such than that the their theirs them then there these they this those through to too under up us very was we were what when where which while who whom why will with would you your yours`.split(/\s+/));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function download(spec) {
  const bytes = execFileSync('curl', [
    '-L', '--fail', '--silent', '--show-error', '--max-time', '90', spec.url,
  ], { maxBuffer: 30 * 1024 * 1024 });
  const digest = sha256(bytes);
  if (digest !== spec.sha256) {
    throw new Error(`Source changed at ${spec.url}: expected ${spec.sha256}, received ${digest}`);
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function between(source, start, end, label) {
  const startMatch = start.exec(source);
  if (!startMatch) throw new Error(`Could not find ${label} start`);
  const bodyStart = startMatch.index + startMatch[0].length;
  const tail = source.slice(bodyStart);
  const endMatch = end.exec(tail);
  if (!endMatch) throw new Error(`Could not find ${label} end`);
  return tail.slice(0, endMatch.index);
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeInline(value) {
  return decodeHtml(value)
    .replace(/\[(?:\d+)\]/g, '')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function paragraphsFromWrappedText(value) {
  return value
    .replace(/^\s*\[Illustration\]\s*$/gim, '')
    .split(/\n\s*\n+/)
    .map(block => normalizeInline(block.split('\n').map(line => line.trim()).join(' ')))
    .filter(Boolean);
}

function pickFocus(text) {
  const candidates = [...text.matchAll(/[A-Za-z]+(?:[’'][A-Za-z]+)*(?:-[A-Za-z]+)*|\b\d{4}\b/g)]
    .map((match, index) => ({ value: match[0], index, lower: match[0].toLocaleLowerCase('en-US') }))
    .filter(candidate => candidate.value.length >= 4 && !stopWords.has(candidate.lower));
  if (candidates.length === 0) {
    return text.match(/[A-Za-z]+(?:[’'][A-Za-z]+)*/)?.[0] || text.slice(0, 24).trim();
  }
  candidates.sort((left, right) => {
    const leftScore = Math.min(left.value.length, 13) + (left.value.includes('-') ? 2 : 0);
    const rightScore = Math.min(right.value.length, 13) + (right.value.includes('-') ? 2 : 0);
    return rightScore - leftScore || left.index - right.index;
  });
  return candidates[0].value;
}

function sentenceRecords(text, essayId, paragraphPosition) {
  const segmented = [...segmenter.segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
  const records = [];
  for (let index = 0; index < segmented.length; index += 1) {
    const sentence = segmented[index];
    if (/^\d+\.$/.test(sentence) && segmented[index + 1]) {
      records.push(`${sentence} ${segmented[index + 1]}`);
      index += 1;
    } else {
      records.push(sentence);
    }
  }
  // Intl.Segmenter correctly recognizes terminal punctuation, but classic essayists often put an
  // exclamation/question inside a continuing sentence without quotation marks: “Hark! in the next
  // room…” or “Not so, O friends! will the god…”. A lowercase continuation is unambiguous here.
  for (let index = 1; index < records.length;) {
    if (/^[a-z]/.test(records[index])) {
      records[index - 1] = `${records[index - 1]} ${records[index]}`;
      records.splice(index, 1);
    } else {
      index += 1;
    }
  }
  if (records.length === 0) throw new Error(`${essayId} paragraph ${paragraphPosition} has no sentences`);
  return records.map((sentence, sentenceIndex) => ({
    id: `${essayId}:p${String(paragraphPosition).padStart(3, '0')}:s${String(sentenceIndex + 1).padStart(2, '0')}`,
    text: sentence,
    focus: pickFocus(sentence),
  }));
}

function buildEssay(id, bodyParagraphs, preface = []) {
  const metadata = essayMetadata[id];
  const paragraphs = [];
  for (const text of preface.map(normalizeInline).filter(Boolean)) {
    paragraphs.push({ kind: 'epigraph', text });
  }
  let bodyPosition = 0;
  for (const text of bodyParagraphs.map(normalizeInline).filter(Boolean)) {
    bodyPosition += 1;
    paragraphs.push({
      kind: 'body',
      id: `${id}:p${String(bodyPosition).padStart(3, '0')}`,
      sentences: sentenceRecords(text, id, bodyPosition),
    });
  }
  const sentences = paragraphs.flatMap(paragraph => paragraph.kind === 'body' ? paragraph.sentences : []);
  const wordCount = sentences.reduce((count, sentence) => count + (sentence.text.match(/[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)*/g)?.length ?? 0), 0);
  return {
    id,
    ...metadata,
    publicDomainNote: 'Public domain in the United States. The reader text preserves the historical wording while removing edition footnote markers and line-wrap formatting.',
    wordCount,
    readingMinutes: Math.max(1, Math.round(wordCount / 210)),
    sentenceCount: sentences.length,
    paragraphs,
  };
}

const source = Object.fromEntries(Object.entries(sourceSpecs).map(([key, spec]) => [key, download(spec)]));

const emersonSection = between(
  source.emerson,
  /\nSELF-RELIANCE\s*\n/,
  /\nFRIENDSHIP\.\[278\]\s*\n/,
  'Self-Reliance',
);
const emersonBodyStart = emersonSection.indexOf('I read the other day');
if (emersonBodyStart < 0) throw new Error('Could not find Self-Reliance body');
const emersonPreface = paragraphsFromWrappedText(emersonSection.slice(0, emersonBodyStart))
  .filter(block => !/^\*\s+\*/.test(block));
const emersonBody = paragraphsFromWrappedText(emersonSection.slice(emersonBodyStart));

const twainSection = between(
  source.twain,
  /\n\s*CORN-PONE OPINIONS\s*\n\s*\(Written in 1900\)\s*\n/,
  /\n\s*THE END\s*\n/,
  'Corn-Pone Opinions',
);
const twainBody = paragraphsFromWrappedText(twainSection)
  .map(paragraph => paragraph.replace(/his ’pinions is\.“,/, 'his ’pinions is.”'));

const duboisSection = between(
  source.dubois,
  /\nI\.\s*\nOf Our Spiritual Strivings\s*\n/,
  /\nII\.\s*\nOf the Dawn of Freedom\s*\n/,
  'Of Our Spiritual Strivings',
);
const duboisBodyStart = duboisSection.indexOf('Between me and the other world');
if (duboisBodyStart < 0) throw new Error('Could not find Of Our Spiritual Strivings body');
const duboisPreface = paragraphsFromWrappedText(duboisSection.slice(0, duboisBodyStart));
const duboisBody = paragraphsFromWrappedText(duboisSection.slice(duboisBodyStart));

const gilmanTable = between(source.gilman, /<TD>/i, /<\/TD>/i, 'Why I Wrote The Yellow Wallpaper');
const gilmanBody = paragraphsFromWrappedText(
  gilmanTable
    .replace(/<\s*(?:p|br)\s*\/?>/gi, '\n\n')
    .replace(/<\/?(?:cite|em|strong)>/gi, '')
    .replace(/<[^>]+>/g, ''),
);

const hurstonSection = between(
  source.hurston,
  /\n\s*Zora Neale Hurston\s*\n/,
  /\n\*\*\* END OF THE PROJECT GUTENBERG EBOOK HOW IT FEELS TO BE COLORED ME \*\*\*/,
  'How It Feels to Be Colored Me',
);
const hurstonBodyStart = hurstonSection.indexOf('_I am colored');
if (hurstonBodyStart < 0) throw new Error('Could not find How It Feels to Be Colored Me body');
const hurstonBody = paragraphsFromWrappedText(hurstonSection.slice(hurstonBodyStart));

const essays = [
  buildEssay('self-reliance', emersonBody, emersonPreface),
  buildEssay('corn-pone-opinions', twainBody),
  buildEssay('spiritual-strivings', duboisBody, duboisPreface),
  buildEssay('why-i-wrote-the-yellow-wallpaper', gilmanBody),
  buildEssay('how-it-feels-to-be-colored-me', hurstonBody),
];

const allSentences = essays.flatMap(essay => essay.paragraphs.flatMap(paragraph =>
  paragraph.kind === 'body' ? paragraph.sentences : []));
const ids = new Set();
for (const sentence of allSentences) {
  if (ids.has(sentence.id)) throw new Error(`Duplicate essay sentence id: ${sentence.id}`);
  ids.add(sentence.id);
  if (!sentence.text.toLocaleLowerCase('en-US').includes(sentence.focus.toLocaleLowerCase('en-US'))) {
    throw new Error(`Focus is absent from ${sentence.id}`);
  }
}

const catalog = {
  version: 1,
  generatedAt: '2026-08-09',
  editorialNote: 'Five public-domain American essays selected for canonical importance, breadth of voice, and usefulness to advanced learners. Historical wording is retained and explained in sentence lessons.',
  essays,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  output: outputPath,
  essays: essays.map(essay => ({ id: essay.id, words: essay.wordCount, sentences: essay.sentenceCount })),
  totalSentences: allSentences.length,
}, null, 2)}\n`);
