import assert from 'node:assert/strict';
import test from 'node:test';
import { sentencePronunciation } from '../../services/sentencePronunciation.ts';
import type { SentenceAnalysis, SentencePronunciationGuide } from '../../types.ts';

const guide = (slowIpa: string, fastIpa: string): SentencePronunciationGuide => ({
  slowIpa,
  fastIpa,
  carefulSpeakerGuide: '',
  fastSpeechFeatures: [],
  intonationAndChunking: '',
  keyDifference: '',
});

const analysis = (fields: Partial<SentenceAnalysis>): SentenceAnalysis => ({
  translation: '',
  americanEnglish: { status: 'american', explanation: '' },
  terms: [],
  imagePrompt: '',
  ...fields,
});

test('both lines come from the pronunciation guide', () => {
  assert.deepEqual(
    sentencePronunciation(analysis({ pronunciation: guide('aɪ ˈwɑnt tu ɡoʊ', 'aɪ ˈwɑnə ɡoʊ') })),
    { citation: 'aɪ ˈwɑnt tu ɡoʊ', connected: 'aɪ ˈwɑnə ɡoʊ' },
  );
});

test('a connected line that reads the same as the careful one is left out', () => {
  assert.deepEqual(sentencePronunciation(analysis({ pronunciation: guide('hɛˈloʊ', 'hɛˈloʊ') })), { citation: 'hɛˈloʊ', connected: undefined });
});

test('an older analysis falls back to its natural-speech IPA for the connected line', () => {
  assert.deepEqual(sentencePronunciation(analysis({ naturalSpeechIpa: 'ˈɡɑnə' })), { citation: undefined, connected: 'ˈɡɑnə' });
  assert.deepEqual(
    sentencePronunciation(analysis({ pronunciation: guide('ˈɡoʊɪŋ tu', ''), naturalSpeechIpa: 'ˈɡɑnə' })),
    { citation: 'ˈɡoʊɪŋ tu', connected: 'ˈɡɑnə' },
  );
});

test('a sentence without an analysis, or with empty lines, has neither line', () => {
  assert.deepEqual(sentencePronunciation(undefined), { citation: undefined, connected: undefined });
  assert.deepEqual(sentencePronunciation(analysis({ pronunciation: guide('', '') })), { citation: undefined, connected: undefined });
});
