import assert from 'node:assert/strict';
import test from 'node:test';
import { connectedSpeechIpa, sentencePronunciation } from '../../services/sentencePronunciation.ts';
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

test('the front page\'s connected-speech line is the fast IPA, else the older natural-speech IPA', () => {
  assert.equal(connectedSpeechIpa(analysis({ pronunciation: guide('aɪ ˈwɑnt tu ɡoʊ', 'aɪ ˈwɑnə ɡoʊ') })), 'aɪ ˈwɑnə ɡoʊ');
  assert.equal(connectedSpeechIpa(analysis({ pronunciation: guide('ˈɡoʊɪŋ tu', ''), naturalSpeechIpa: 'ˈɡɑnə' })), 'ˈɡɑnə');
  assert.equal(connectedSpeechIpa(analysis({ naturalSpeechIpa: 'ˈɡɑnə' })), 'ˈɡɑnə');
  assert.equal(connectedSpeechIpa(analysis({ pronunciation: guide('', ''), naturalSpeechIpa: '' })), undefined);
  assert.equal(connectedSpeechIpa(analysis({})), undefined);
  assert.equal(connectedSpeechIpa(undefined), undefined);
});

test('the front page shows the connected line even when it reads as the careful one, which the analysis page leaves out', () => {
  // The front page shows no careful line, so leaving the connected one out there would leave no IPA at all.
  const same = analysis({ pronunciation: guide('hɛˈloʊ', 'hɛˈloʊ') });
  assert.equal(connectedSpeechIpa(same), 'hɛˈloʊ');
  assert.equal(sentencePronunciation(same).connected, undefined);
  assert.equal(sentencePronunciation(same).citation, 'hɛˈloʊ');
});
