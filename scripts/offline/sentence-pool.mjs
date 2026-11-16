// Sentence identity for the example-sentence pools, their verifier and the sentence-image preparer.
//
// Production accepts a sentence bundle only when each entry's lookupHash is the hash of its normalized text and its id
// is example-<first 40 hex of the lookupHash>, so the lookup normalization, the hashes and the ids are the server's
// own, from server/src/sentence-lookup.ts. server/test/sentence-pool.test.ts checks that a record built here passes
// the server's bundle validation.
import { createHash } from 'node:crypto';
import {
  exampleSentenceId,
  normalizeSentenceLookup as serverNormalizeSentenceLookup,
  sentenceLookupHash,
  sentenceTextHash,
} from '../../server/src/sentence-lookup.ts';

export { exampleSentenceId, sentenceLookupHash, sentenceTextHash };

// The server's function itself. Its String(value || '') reads a missing text as '', and the pool builder passes saved
// sentences' texts, which a malformed record may lack, so the type admits one.
/** @type {(value: string | undefined) => string} */
export const normalizeSentenceLookup = serverNormalizeSentenceLookup;

const sha256 = value => createHash('sha256').update(value).digest('hex');

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
