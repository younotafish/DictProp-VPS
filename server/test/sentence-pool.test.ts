import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSentenceLookup,
  sentenceLookupHash,
  validateSentenceEnrichmentBundle,
} from '../src/sentence-enrichment.js';
import {
  exampleSentenceId,
  normalizeSentenceLookup as offlineNormalizeSentenceLookup,
  poolSentence,
  sentenceImageFilename,
  sentenceLookupHash as offlineSentenceLookupHash,
  sentenceTextHash,
} from '../../scripts/offline/sentence-pool.mjs';
import { completeAnalysis } from './support/fixtures.js';
import { sha256 } from './support/fs.js';

// Every fold the lookup applies, alone and combined: markup, NFKC forms, case, quotes, dashes and whitespace.
const texts = [
  'She said, “Don’t {{give up}} now.”',
  'She said, "Don\'t give up now."',
  '  She   said,\t“don’t [[give up]] NOW.”  ',
  '‘Single’ and “double” curly quotes.',
  'An en dash – and an em dash — between words.',
  'Full-width ＡＢＣ１２３ and the ligatures ﬁ ﬂ.',
  'A non-breaking\u00a0space, an em\u2003space and a thin\u2009space.',
  'Tabs\tand\nnewlines\r\nbetween words.',
  'Nested {{a {{b}} c}} and [[x [[y]] z]] markup.',
  'Adjacent {{one}}{{two}} and [[three]][[four]] markers.',
  'Empty markers {{}} and [[]] stay as they are.',
  'Unbalanced {{markup and ]] brackets.',
  'Ⅻ ㎏ ℃ and Ǆ fold under NFKC.',
  'Cafe\u0301, nai\u0308ve and coo\u0308perate spelled with combining marks.',
  '',
  '   ',
];

test('the offline sentence lookup normalizes and hashes exactly as the server does', () => {
  for (const text of texts) {
    assert.equal(offlineNormalizeSentenceLookup(text), normalizeSentenceLookup(text), JSON.stringify(text));
    assert.equal(offlineSentenceLookupHash(text), sentenceLookupHash(text), JSON.stringify(text));
  }
  // The server's String(value || '') turns a missing text into ''.
  assert.equal(offlineNormalizeSentenceLookup(undefined), normalizeSentenceLookup(undefined as unknown as string));
});

test('texts that differ only in markup, case, quotes or spacing share one lookup identity', () => {
  assert.equal(offlineSentenceLookupHash(texts[0]), offlineSentenceLookupHash(texts[1]));
  assert.equal(offlineSentenceLookupHash(texts[0]), offlineSentenceLookupHash(texts[2]));
  assert.notEqual(sentenceTextHash(texts[0]), sentenceTextHash(texts[1]));
});

test('pool records built offline pass the server bundle validation that production applies', () => {
  const seen = new Set<string>();
  const entries = texts
    .filter(text => {
      const lookupHash = offlineSentenceLookupHash(text);
      if (!text.trim() || seen.has(lookupHash)) return false;
      seen.add(lookupHash);
      return true;
    })
    .map((text, index) => {
      const record = poolSentence({
        text,
        lookupHash: offlineSentenceLookupHash(text),
        sourceWord: 'word',
        sourceSense: 'sense',
        provenance: { parentId: `parent-${index}` },
      });
      return {
        id: record.id,
        text: record.text,
        lookupHash: record.lookupHash,
        textHash: record.textHash,
        analysis: completeAnalysis,
        generatedAt: 1,
        imageFile: `images/${sentenceImageFilename(record.id)}`,
      };
    });
  assert.ok(entries.length >= 10);
  assert.equal(validateSentenceEnrichmentBundle({ version: 1, generatedAt: 1, entries }), null);
});

test('a pool record carries the identity fields in the order the pools have always written them', () => {
  const text = 'The “first” {{example}}.';
  const lookupHash = sentenceLookupHash(text);
  const record = poolSentence({
    text,
    lookupHash,
    sourceWord: 'example',
    sourceSense: 'An Essay — A. Writer',
    context: { contextBefore: 'Before.', contextAfter: 'After.' },
    hasImage: true,
    provenance: { essayId: 'essay' },
  });
  assert.deepEqual(Object.entries(record), [
    ['id', `example-${lookupHash.slice(0, 40)}`],
    ['text', text],
    ['sourceWord', 'example'],
    ['sourceSense', 'An Essay — A. Writer'],
    ['contextBefore', 'Before.'],
    ['contextAfter', 'After.'],
    ['textHash', sha256(text)],
    ['lookupHash', lookupHash],
    ['hasAnalysis', false],
    ['hasImage', true],
    ['provenance', [{ essayId: 'essay' }]],
  ]);
  assert.equal(exampleSentenceId(lookupHash), record.id);
  assert.equal(sentenceImageFilename(record.id), `${sha256(record.id).slice(0, 32)}.webp`);
});
