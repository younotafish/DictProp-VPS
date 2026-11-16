import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisRecords,
  leakedPlaceholder,
  plainSentence,
  preservedGrammarFor,
  readAnalysisResults,
  readBaseAnalyses,
  validTermIpa,
  validateAnalysis,
} from '../../scripts/offline/sentence-analysis-checks.mjs';

const sentence = { id: 'come-clean', text: 'He finally {{came clean}} about [[it]].', textHash: 'hash-1', sourceWord: 'come clean' };

const term = (overrides: Record<string, unknown> = {}) => ({
  term: 'come clean',
  chinese: '坦白',
  ipa: '/kʌm klin/',
  originalMeaning: 'To confess the truth.',
  synonyms: ['confess'],
  antonyms: ['conceal'],
  examples: ['She came clean about the dent.', 'It is time to come clean with your team.'],
  historicalEvolution: 'From the idea of washing away concealment.',
  ...overrides,
});

const analysis = (overrides: Record<string, unknown> = {}) => ({
  translation: '他终于坦白了。',
  americanEnglish: {
    status: 'shared',
    explanation: 'Yes. Natural in educated American English.',
    evidence: ['Come clean is a current idiom.'],
  },
  terms: [term()],
  pronunciation: {
    slowIpa: '/hi ˈfaɪnəli keɪm klin əˈbaʊt ɪt/',
    fastIpa: '/hi ˈfaɪnəli keɪm ˈklinəˌbaʊɾɪt/',
    carefulSpeakerGuide: 'he FI-nal-ly / came CLEAN / a-BOUT it',
    fastSpeechFeatures: ['about it links with a flap.'],
    intonationAndChunking: 'He finally came clean ↘ / about it ↘',
    keyDifference: 'Fluent speech links about it.',
  },
  grammar: {
    structure: 'A simple clause with a phrasal predicate.',
    points: [{ label: 'Simple past', excerpt: 'came clean', explanation: 'A completed event.' }],
  },
  imagePrompt: 'A realistic photograph of a man confessing to a friend at a kitchen table, natural light, no text.',
  ...overrides,
});

const strict = { baseAnalysisById: new Map(), deferGrammarValidation: false };

test('the sentence the model sees has no target or lookup markers', () => {
  assert.equal(plainSentence(sentence.text), 'He finally came clean about it.');
  assert.equal(plainSentence(undefined), '');
});

test('term IPA allows several transcriptions joined by separators and short labels, nothing else', () => {
  assert.equal(validTermIpa('/rɛd/'), true);
  assert.equal(validTermIpa('/rid/ (present); /rɛd/ (past)'), true);
  assert.equal(validTermIpa('/ˈɹɛkɚd/ noun – /ɹɪˈkɔɹd/ verb'), true);
  assert.equal(validTermIpa('red'), false);
  assert.equal(validTermIpa('/rid/ as in reed'), false);
  assert.equal(validTermIpa('/rid/ / rɛd'), false);
});

test('placeholders and schema field names are caught as leaked content', () => {
  for (const value of ['placeholder', 'TBD.', ' todo ', 'slow IPA', 'Fast IPA placeholder', 'image prompt!', 'historical evolution']) {
    assert.equal(leakedPlaceholder(value), true, value);
  }
  for (const value of ['A real explanation.', 'image prompts help', '']) assert.equal(leakedPlaceholder(value), false, value);
});

test('the base manifest must name every analysis once', () => {
  const base = readBaseAnalyses({ version: 1, entries: [{ id: 'a', textHash: 'h' }] });
  assert.deepEqual([...base.keys()], ['a']);
  assert.throws(() => readBaseAnalyses({ version: 2, entries: [] }), /^Error: Base analysis manifest is invalid$/);
  assert.throws(() => readBaseAnalyses({ version: 1, entries: [{ id: 'a', textHash: 'h' }, { id: 'a', textHash: 'h' }] }),
    /^Error: Base analysis manifest has an invalid identity$/);
  assert.throws(() => readBaseAnalyses({ version: 1, entries: [{ id: 'a' }] }), /invalid identity/);
});

test('an earlier grammar is kept only for the same text and only while its excerpts still quote it', () => {
  const grammar = { structure: 'Kept.', points: [{ label: 'Verb', excerpt: 'came clean', explanation: 'Past.' }] };
  const base = readBaseAnalyses({ version: 1, entries: [
    { id: 'come-clean', textHash: 'hash-1', analysis: { grammar } },
    { id: 'legacy', textHash: 'hash-2', grammar },
    { id: 'drifted', textHash: 'hash-3', grammar: { ...grammar, points: [{ ...grammar.points[0], excerpt: 'went clean' }] } },
  ] });
  assert.equal(preservedGrammarFor(base, sentence), grammar);
  assert.equal(preservedGrammarFor(base, { ...sentence, textHash: 'edited' }), undefined);
  assert.equal(preservedGrammarFor(base, { ...sentence, id: 'legacy', textHash: 'hash-2' }), grammar);
  assert.equal(preservedGrammarFor(base, { ...sentence, id: 'drifted', textHash: 'hash-3' }), undefined);

  const [record] = analysisRecords([{ ...sentence, contextBefore: 'Before {{x}}.' }], base);
  assert.deepEqual(record, {
    itemIndex: 0,
    text: 'He finally came clean about it.',
    sourceWord: 'come clean',
    sourceSense: undefined,
    contextBefore: 'Before x.',
    preservedGrammar: grammar,
  });
  assert.deepEqual(Object.keys(analysisRecords([sentence], new Map())[0]), ['itemIndex', 'text', 'sourceWord', 'sourceSense']);
});

test('a complete analysis is accepted, with its natural-speech IPA filled from the fluent transcription', () => {
  const accepted = validateAnalysis(analysis(), sentence, strict);
  assert.equal(accepted.naturalSpeechIpa, accepted.pronunciation.fastIpa);
  // An abbreviated or loosely quoted excerpt is recovered to the exact source span before checking.
  const recovered = validateAnalysis(analysis({
    grammar: { structure: 'S.', points: [{ label: 'Span', excerpt: 'finally … about', explanation: 'E.' }] },
  }), sentence, strict);
  assert.equal(recovered.grammar.points[0].excerpt, 'finally came clean about');
});

test('each check names what the model must fix', () => {
  const reject = (candidate: unknown, pattern: RegExp, options = strict) =>
    assert.throws(() => validateAnalysis(candidate, sentence, options), pattern);
  // What the contract finds missing, in the server's words.
  reject({ ...analysis(), translation: '' }, /^Error: come-clean: translation must be a non-empty string$/);
  reject({ ...analysis(), translation: '', imagePrompt: ' ' },
    /^Error: come-clean: translation must be a non-empty string; imagePrompt must be a non-empty string$/);
  // A complete analysis inside a provider's envelope gives the server no reason, so the message stays general.
  reject({ result: analysis() }, /^Error: come-clean: incomplete detailed sentence analysis$/);
  reject(analysis({ americanEnglish: { status: 'shared', explanation: 'Natural.', evidence: ['x'] } }),
    /must begin with Yes or No/);
  reject(analysis({ imagePrompt: 'Image prompt' }), /placeholder or schema field leaked into sentence analysis/);
  reject(analysis({ grammar: { structure: 'TBD', points: [] } }), /placeholder leaked into grammar structure/);
  reject(analysis({ grammar: { structure: 'S.', points: [{ label: 'X', excerpt: 'not in the sentence', explanation: 'E.' }] } }),
    /grammar excerpt "not in the sentence" is not an exact quote from "He finally came clean about it\."/);
  const point = { label: 'Verb', excerpt: 'came clean', explanation: 'E.' };
  reject(analysis({ grammar: { structure: 'S.', points: [point, { ...point, label: ' verb ' }] } }), /duplicate grammar point/);
  reject(analysis({ terms: [term({ ipa: 'kum klin' })] }), /invalid term analysis/);
  reject(analysis({ terms: [term(), term({ term: 'Come  Clean' })] }), /duplicate term Come {2}Clean/);
  reject(analysis({ terms: [term({ antonyms: ['TBD'] })] }), /placeholder or schema field leaked into term come clean/);
  reject(analysis({ terms: [term({ examples: ['Same one.', ' same ONE. '] })] }), /duplicate example for term come clean/);
});

test('deferred grammar validation leaves grammar points for a later pass', () => {
  const loose = analysis({ grammar: { structure: 'S.', points: [{ label: 'X', excerpt: 'not in the sentence', explanation: 'E.' }] } });
  assert.doesNotThrow(() => validateAnalysis(loose, sentence, { ...strict, deferGrammarValidation: true }));
});

test('a batch answer is read by item index and each analysis checked', () => {
  const batch = [sentence, { ...sentence, id: 'second' }];
  const results = readAnalysisResults({
    results: [{ itemIndex: 1, analysis: analysis() }, { itemIndex: 0, analysis: analysis() }],
  }, batch, strict);
  assert.deepEqual(results.map(({ sourceRecord }: { sourceRecord: { id: string } }) => sourceRecord.id), ['come-clean', 'second']);
  assert.throws(() => readAnalysisResults({ results: [] }, batch, strict), /^Error: Wrong analysis result count$/);
  assert.throws(() => readAnalysisResults({ results: [{ itemIndex: 0 }, { itemIndex: 0 }] }, batch, strict),
    /^Error: Duplicate sentence indexes$/);
  assert.throws(() => readAnalysisResults({ results: [{ itemIndex: 0, analysis: analysis() }, { itemIndex: 2 }] }, batch, strict),
    /^Error: Missing sentence index 1$/);
});
