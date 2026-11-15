import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { poolSentence, sentenceImageFilename, sentenceLookupHash } from '../../scripts/offline/sentence-pool.mjs';
import { writeJson } from '../support/fs.ts';
import { repoPath } from '../support/paths.ts';

const script = repoPath('scripts', 'offline', 'verify-example-sentence-pool.mjs');

const detailed = {
  translation: '这是一个例句。',
  naturalSpeechIpa: '/ðɪs ɪz ə tɛst/',
  grammar: { structure: 'A simple declarative clause.', points: [] },
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. This is natural in American English.',
    evidence: ['The wording is current and idiomatic.'],
  },
  terms: [{
    term: 'test',
    chinese: '测试',
    ipa: '/tɛst/',
    originalMeaning: 'A procedure that checks quality or ability.',
    synonyms: ['trial'],
    antonyms: [],
    examples: ['We ran one more test.', 'The test took an hour.'],
    historicalEvolution: 'From Latin testum, an earthen pot used to assay metals.',
  }],
  pronunciation: {
    slowIpa: '/ðɪs ɪz ə tɛst/',
    fastIpa: '/ðɪs ɪz ə tɛst/',
    carefulSpeakerGuide: 'this IS a TEST',
    fastSpeechFeatures: ['The article is reduced in fluent speech.'],
    intonationAndChunking: 'Use one thought group with a final fall.',
    keyDifference: 'Fluent speech reduces the unstressed article.',
  },
  imagePrompt: 'A photorealistic wide image of a student completing a short test at a desk, with no visible text.',
};
const { grammar: _grammar, pronunciation: _pronunciation, naturalSpeechIpa: _ipa, ...basic } = detailed;

const sentence = (text: string, coverage: { hasAnalysis?: boolean; hasImage?: boolean } = {}) => poolSentence({
  text,
  lookupHash: sentenceLookupHash(text),
  sourceWord: 'test',
  sourceSense: 'noun: a check',
  provenance: { parentId: 'card', parentType: 'vocab' },
  ...coverage,
});

function verify(sentences: unknown[], analyses: Array<{ id: string; textHash: string; analysis: unknown }>, bundle?: string) {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-verify-pool-'));
  writeJson(join(root, 'source.json'), { version: 1, sentences });
  writeJson(join(root, 'analysis.json'), { version: 1, entries: analyses });
  const args = [script, join(root, 'source.json'), join(root, 'analysis.json')];
  if (bundle) args.push(bundle);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

test('the pool verifier accepts a detailed analysis, and a basic one only for a sentence production already covers', () => {
  const uncovered = sentence('This {{test}} still needs its explanation.');
  const covered = sentence('This {{test}} already has one in production.', { hasAnalysis: true, hasImage: true });

  const result = verify([uncovered, covered], [
    { id: uncovered.id, textHash: uncovered.textHash, analysis: detailed },
    { id: covered.id, textHash: covered.textHash, analysis: basic },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verified, true);

  const basicForUncovered = verify([uncovered], [{ id: uncovered.id, textHash: uncovered.textHash, analysis: basic }]);
  assert.notEqual(basicForUncovered.status, 0);
  assert.match(basicForUncovered.stderr, new RegExp(`${uncovered.id}: detailed sentence analysis is incomplete`));

  const unimportable = verify([covered], [{
    id: covered.id, textHash: covered.textHash, analysis: { ...basic, americanEnglish: { status: 'unknown' } },
  }]);
  assert.notEqual(unimportable.status, 0);
  assert.match(unimportable.stderr, new RegExp(`${covered.id}: production-covered sentence analysis is not importable`));
});

test('the pool verifier refuses a broken identity, an analysis gap and an image under the wrong name', () => {
  const first = sentence('The first {{test}} sentence.');
  const second = sentence('The second {{test}} sentence.');
  const analyses = [first, second].map(value => ({ id: value.id, textHash: value.textHash, analysis: detailed }));

  assert.match(verify([{ ...first, id: `${first.id}0` }, second], analyses).stderr, /id does not match lookup hash/);
  assert.match(verify([{ ...first, text: `${first.text} ` }, second], analyses).stderr, /text hash mismatch/);
  assert.match(
    verify([{ ...first, text: 'The first {{test}} line.', textHash: sentence('The first {{test}} line.').textHash }, second], analyses)
      .stderr,
    /normalized lookup hash mismatch/,
  );
  assert.match(verify([first, second], analyses.slice(0, 1)).stderr, /Analysis coverage mismatch: 1\/2/);

  const bundle = mkdtempSync(join(tmpdir(), 'dictprop-verify-bundle-'));
  mkdirSync(join(bundle, 'images'));
  writeJson(join(bundle, 'targets.json'), {
    version: 1,
    targets: [first, second].map(value => ({
      imageId: value.id, filename: sentenceImageFilename(value.id), prompt: detailed.imagePrompt,
    })),
  });
  writeJson(join(bundle, 'manifest.json'), {
    version: 1,
    entries: [first, second].map(value => ({
      id: value.id, textHash: value.textHash, imageFile: `images/${sentenceImageFilename(value.id)}`,
    })),
  });
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  for (const value of [first, second]) writeFileSync(join(bundle, 'images', sentenceImageFilename(value.id)), webp);
  const complete = verify([first, second], analyses, bundle);
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).images, 2);

  writeJson(join(bundle, 'targets.json'), {
    version: 1,
    targets: [first, second].map(value => ({ imageId: value.id, filename: 'renamed.webp', prompt: detailed.imagePrompt })),
  });
  assert.match(verify([first, second], analyses, bundle).stderr, /unexpected image filename/);
});
