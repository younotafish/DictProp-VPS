// Sentence identity for the example-sentence pools, their verifier and the sentence-image preparer.
//
// Production decides whether a sentence bundle is accepted with server/src/sentence-enrichment.ts: it refuses an
// entry whose lookupHash is not the hash of the normalized text, or whose id is not example-<first 40 hex of the
// lookupHash>. normalizeSentenceLookup below copies the server's function, because plain node can't load that module
// (it imports ./sentence-analysis.js). server/test/sentence-pool.test.ts holds the two to the same output, and checks
// that a record built here passes the server's bundle validation. Once the server keeps the function in a module
// with no relative imports, re-export it from there instead of copying it.
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');

/** The text a lookup compares: learning markup removed, Unicode-normalized, lowercased, quotes and dashes folded. */
export function normalizeSentenceLookup(value) {
  return String(value || '')
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^[\]]+)\]\]/g, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The lookup identity: two texts that differ only in markup, case, quotes, dashes or spacing share it. */
export const sentenceLookupHash = text => sha256(normalizeSentenceLookup(text));

/** The exact-text identity: an analysis or image belongs to the text it was made for. */
export const sentenceTextHash = text => sha256(text);

/** A pooled example sentence's id, from its lookup hash. */
export const exampleSentenceId = lookupHash => `example-${lookupHash.slice(0, 40)}`;

/** The file a sentence's image is rendered to and published as, under the bundle's images/. */
export const sentenceImageFilename = id => `${sha256(id).slice(0, 32)}.webp`;

/**
 * One sentence-pool record, the shape reconciliation, the verifier and the waves read. `context` adds fields a pool
 * carries for analysis (an essay's neighbouring sentences); a new record starts with one provenance entry, and the
 * pool builders append further ones when the same lookup hash recurs.
 */
export function poolSentence({
  text, lookupHash, sourceWord, sourceSense, context = {}, hasAnalysis = false, hasImage = false, provenance,
}) {
  return {
    id: exampleSentenceId(lookupHash),
    text,
    sourceWord,
    sourceSense,
    ...context,
    textHash: sentenceTextHash(text),
    lookupHash,
    hasAnalysis,
    hasImage,
    provenance: [provenance],
  };
}
