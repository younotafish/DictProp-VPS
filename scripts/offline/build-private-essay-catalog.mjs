#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [manifestArg, outputArg] = process.argv.slice(2);
if (!manifestArg || !outputArg) {
  throw new Error('Usage: build-private-essay-catalog.mjs <manifest.json> <catalog.json>');
}

const manifestPath = resolve(manifestArg);
const outputPath = resolve(outputArg);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest?.version !== 1 || !Array.isArray(manifest.essays) || manifest.essays.length === 0) {
  throw new Error('Private essay manifest must contain at least one version 1 essay');
}

const segmenter = new Intl.Segmenter('en-US', { granularity: 'sentence' });
const stopWords = new Set(`a although an and are as at be because been being but by can could did do does doing even for from had has have having he her hers him his how i if in into is it its may me might more most must my no nor not of on one or our ours she should so some such than that the their theirs them then there these they this those though through to too under up us very was we were what when where which while who whom why will with would you your yours`.split(/\s+/));
// Preserve historically important wording in the reader without turning slurs into cloze targets.
const blockedFocusWords = new Set(['nigger', 'darkies']);
const functionFocusWords = new Set(`aren't can't couldn't didn't doesn't don't hadn't hasn't haven't here's i'm i'll isn't it's that's there's they're they've we're we've weren't what's who's won't wouldn't you’re you're`.split(/\s+/));

function pickFocus(text) {
  const tokens = [...text.matchAll(/[A-Za-z]+(?:[’'][A-Za-z]+)*(?:-[A-Za-z]+)*/g)]
    .map((match, index) => ({ value: match[0], index, lower: match[0].toLocaleLowerCase('en-US') }));
  const candidates = tokens
    .filter(candidate => candidate.value.length >= 4 &&
      !stopWords.has(candidate.lower) && !blockedFocusWords.has(candidate.lower) &&
      !functionFocusWords.has(candidate.lower.replace(/’/g, "'")));
  if (candidates.length === 0) {
    const safeFallback = tokens
      .filter(candidate => !blockedFocusWords.has(candidate.lower))
      .sort((left, right) => right.value.length - left.value.length || left.index - right.index)[0];
    return safeFallback?.value || text.slice(0, 24).trim();
  }
  candidates.sort((left, right) => {
    const score = candidate => Math.min(candidate.value.length, 14) + (candidate.value.includes('-') ? 2 : 0);
    return score(right) - score(left) || left.index - right.index;
  });
  return candidates[0].value;
}

function normalizeParagraph(value) {
  return value
    .normalize('NFC')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function sentencesFor(text, essayId, paragraphPosition) {
  const rawSegments = [...segmenter.segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
  const segments = [];
  for (const segment of rawSegments) {
    const previous = segments.at(-1);
    if (previous && /\b(?:Mr|Mrs|Ms|Dr|Prof|Sen|Rep|Gov|Gen|Lt|Col|Sgt)\.$/.test(previous)) {
      segments[segments.length - 1] = `${previous} ${segment}`;
    } else {
      segments.push(segment);
    }
  }
  if (segments.length === 0) throw new Error(`${essayId} paragraph ${paragraphPosition} has no sentences`);
  return segments.map((sentence, sentenceIndex) => {
    if (sentence.length > 4_000) throw new Error(`${essayId} contains a sentence longer than 4,000 characters`);
    return {
      id: `${essayId}:p${String(paragraphPosition).padStart(3, '0')}:s${String(sentenceIndex + 1).padStart(2, '0')}`,
      text: sentence,
      focus: pickFocus(sentence),
    };
  });
}

const essayIds = new Set();
const essays = manifest.essays.map(spec => {
  if (!spec?.id || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(spec.id) || essayIds.has(spec.id)) {
    throw new Error(`Invalid or duplicate essay id: ${spec?.id || 'unknown'}`);
  }
  if (!spec.textFile || !spec.rightsNote) {
    throw new Error(`${spec.id} must provide textFile and rightsNote`);
  }
  essayIds.add(spec.id);
  const textPath = resolve(dirname(manifestPath), spec.textFile);
  const rawText = readFileSync(textPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const blocks = rawText.split(/\n\s*\n+/).map(normalizeParagraph).filter(Boolean);
  if (blocks.length === 0) throw new Error(`${spec.id} has no readable paragraphs`);
  const paragraphs = blocks.map((text, index) => ({
    kind: 'body',
    id: `${spec.id}:p${String(index + 1).padStart(3, '0')}`,
    sentences: sentencesFor(text, spec.id, index + 1),
  }));
  const sentences = paragraphs.flatMap(paragraph => paragraph.sentences);
  const wordCount = sentences.reduce((total, sentence) =>
    total + (sentence.text.match(/[A-Za-z0-9]+(?:[’'][A-Za-z0-9]+)*/g)?.length ?? 0), 0);
  const textDigest = createHash('sha256').update(rawText).digest('hex');
  const { textFile: _textFile, ...metadata } = spec;
  return {
    ...metadata,
    collection: 'modern',
    publicDomainNote: 'Owner-private study copy; the full text is not included in the public application repository or bundle.',
    wordCount,
    readingMinutes: Math.max(1, Math.round(wordCount / 210)),
    sentenceCount: sentences.length,
    sourceTextSha256: textDigest,
    paragraphs,
  };
});

// The digest is useful while preparing private source files but is not part of the runtime schema.
const sourceDigests = Object.fromEntries(essays.map(essay => [essay.id, essay.sourceTextSha256]));
for (const essay of essays) delete essay.sourceTextSha256;

const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  editorialNote: String(manifest.editorialNote || 'Owner-private modern American essay collection.'),
  essays,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  output: outputPath,
  essays: essays.map(essay => ({
    id: essay.id,
    words: essay.wordCount,
    sentences: essay.sentenceCount,
    sourceTextSha256: sourceDigests[essay.id],
  })),
  totalSentences: essays.reduce((total, essay) => total + essay.sentenceCount, 0),
}, null, 2)}\n`);
