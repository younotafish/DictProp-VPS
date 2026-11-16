import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudyContent } from '../../services/studySession.ts';
import {
  TASK_INSTRUCTIONS,
  createClozePrompt,
  judgeTypedAnswer,
  maskAnswer,
  partOfSpeechOf,
  pickExample,
  studyPrompt,
  verdictLine,
} from '../../services/studyPrompt.ts';

const content = (fields: Partial<StudyContent> = {}): StudyContent => ({
  word: 'crestfallen', sense: '', chinese: '', definition: '', example: '', forms: [], synonyms: [], ...fields,
});

test('cloze prompts hide marked inflections and strip secondary markers', () => {
  assert.equal(
    createClozePrompt('They {{led}} the group with [[aplomb]].', 'lead'),
    'They _____ the group with aplomb.',
  );
  assert.equal(createClozePrompt('Please lead the way.', 'lead'), 'Please _____ the way.');
});

test('each task says what it asks', () => {
  assert.deepEqual(TASK_INSTRUCTIONS, {
    meaning: 'Recall the meaning',
    production: 'Type the English word',
    cloze: 'Fill in the blank',
    listening: 'Listen to the sentence',
  });
});

test('a sense label gives its part of speech only when it starts with a known one', () => {
  assert.equal(partOfSpeechOf('noun: emotion'), 'noun');
  assert.equal(partOfSpeechOf('Phrasal verb: give in'), 'phrasal verb');
  assert.equal(partOfSpeechOf(' verb: to guide'), 'verb');
  assert.equal(partOfSpeechOf('adjective (formal)'), 'adjective');
  assert.equal(partOfSpeechOf('adverb'), 'adverb');
  assert.equal(partOfSpeechOf('idiom: on the fence'), 'idiom');
  assert.equal(partOfSpeechOf('adj. calm'), '');
  assert.equal(partOfSpeechOf('verbal: spoken'), '');
  assert.equal(partOfSpeechOf('metal'), '');
  assert.equal(partOfSpeechOf(''), '');
  assert.equal(partOfSpeechOf(undefined), '');
});

test('a meaning prompt for one of several senses says which of how many; a single sense shows nothing extra', () => {
  assert.deepEqual(studyPrompt(content({ word: 'lead', sense: 'noun: emotion' }), 'meaning', 3), {
    text: 'lead', sub: 'noun · one of 3 meanings', multiWord: false,
  });
  assert.deepEqual(studyPrompt(content({ word: 'lead', sense: 'adj. calm' }), 'meaning', 3), {
    text: 'lead', sub: 'one of 3 meanings', multiWord: false,
  });
  assert.deepEqual(studyPrompt(content({ word: 'lead', sense: 'noun: emotion' }), 'meaning', 1), { text: 'lead', multiWord: false });
  assert.deepEqual(studyPrompt(content({ word: ' give up ' }), 'meaning', 1), { text: ' give up ', multiWord: true });
});

test('a production prompt shows the Chinese with the English definition beneath it, the answer masked in both', () => {
  const card = content({ word: 'lead', forms: ['leads, led, leading'], chinese: '带领 (lead)', definition: 'To lead is to guide; she led them home.' });
  assert.deepEqual(studyPrompt(card, 'production', 1), {
    text: '带领 (_____)', detail: 'To _____ is to guide; she _____ them home.', multiWord: false,
  });
  // Without Chinese the masked definition is the prompt.
  assert.deepEqual(studyPrompt({ ...card, chinese: '' }, 'production', 1), { text: 'To _____ is to guide; she _____ them home.', multiWord: false });
  assert.deepEqual(studyPrompt({ ...card, definition: '' }, 'production', 1), { text: '带领 (_____)', multiWord: false });
});

test('cloze prompts blank the word, and listening prompts show no text', () => {
  const card = content({ word: 'lead', example: 'They {{led}} the group.' });
  assert.deepEqual(studyPrompt(card, 'cloze', 2), { text: 'They _____ the group.', multiWord: false });
  assert.deepEqual(studyPrompt(card, 'listening', 2), { text: '', multiWord: false });
});

test('the answer is masked as a whole word and in its listed forms, in any case, wherever it stands', () => {
  assert.equal(maskAnswer('Lead the way; she led them, the leader.', 'lead', ['led']), '_____ the way; she _____ them, the leader.');
  assert.equal(maskAnswer('Never GIVE   UP, or give\nup hope.', 'give up'), 'Never _____, or _____ hope.');
  // Longest first, so a form that contains the word goes whole.
  assert.equal(maskAnswer('He gave up and gives up.', 'give up', ['gave up', 'gives up']), 'He _____ and _____.');
  // Labels and brackets in the forms list don't get in the way; a one-letter form is left alone.
  assert.equal(maskAnswer('Compasses point north; it\'s a compass.', 'compass', ['plural: compasses', '-s']), '_____ point north; it\'s a _____.');
  // Accented letters count as letters, and a curly apostrophe matches a straight one.
  assert.equal(maskAnswer('café cafés', 'café'), '_____ cafés');
  assert.equal(maskAnswer('Let’s go, let\'s.', "let's"), '_____ go, _____.');
  // Characters regular expressions treat specially are matched as written.
  assert.equal(maskAnswer('C++ (c++) and c', 'c++'), '_____ (_____) and c');
  assert.equal(maskAnswer('', 'lead'), '');
  assert.equal(maskAnswer('Nothing here', ''), 'Nothing here');
});

test('examples take turns as reviews add up, two reviews to each, skipping blank ones', () => {
  const examples = ['first', '  ', 'second', 'third'];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(reviews => pickExample(examples, reviews)), [
    'first', 'first', 'second', 'second', 'third', 'third', 'first', 'first',
  ]);
  assert.equal(pickExample(['only'], 9), 'only');
  assert.equal(pickExample([], 3), '');
  assert.equal(pickExample(['', ' '], 3), '');
  assert.equal(pickExample(undefined, 3), '');
  assert.equal(pickExample(['first', 'second'], Number.NaN), 'first');
});

test('a typed answer is correct as the word or a listed form, whatever its case, spacing and edge punctuation', () => {
  const card = { word: 'Lead', forms: ['leads, led', 'leading'], synonyms: ['guide', 'Steer'] };
  assert.deepEqual(judgeTypedAnswer('  lead ', card), { kind: 'correct', typed: 'lead' });
  assert.deepEqual(judgeTypedAnswer('LED!', card), { kind: 'correct', typed: 'LED!' });
  assert.deepEqual(judgeTypedAnswer('"leading"', card), { kind: 'correct', typed: '"leading"' });
  assert.deepEqual(judgeTypedAnswer('steer', card), { kind: 'synonym', typed: 'steer' });
  assert.deepEqual(judgeTypedAnswer('follow', card), { kind: 'wrong', typed: 'follow' });
  assert.deepEqual(judgeTypedAnswer('   ', card), { kind: 'empty' });
  assert.deepEqual(judgeTypedAnswer('?!', card), { kind: 'empty' });
  assert.deepEqual(judgeTypedAnswer('give  up', { word: 'give up' }), { kind: 'correct', typed: 'give  up' });
});

test('a misspelling is a typo within one edit for 4 to 7 letters and two from 8, and under 4 letters only exact counts', () => {
  const crestfallen = { word: 'crestfallen' };
  assert.deepEqual(judgeTypedAnswer('crestfalen', crestfallen), { kind: 'typo', typed: 'crestfalen', distance: 1 });
  assert.deepEqual(judgeTypedAnswer('cretsfalen', crestfallen), { kind: 'typo', typed: 'cretsfalen', distance: 2 });
  assert.deepEqual(judgeTypedAnswer('crstfaln', crestfallen), { kind: 'wrong', typed: 'crstfaln' });
  // A swap of two neighbours is one edit.
  assert.deepEqual(judgeTypedAnswer('wlak', { word: 'walk' }), { kind: 'typo', typed: 'wlak', distance: 1 });
  assert.deepEqual(judgeTypedAnswer('walks', { word: 'walk' }), { kind: 'typo', typed: 'walks', distance: 1 });
  assert.deepEqual(judgeTypedAnswer('wlkz', { word: 'walk' }), { kind: 'wrong', typed: 'wlkz' });
  assert.deepEqual(judgeTypedAnswer('rn', { word: 'run' }), { kind: 'wrong', typed: 'rn' });
  // A form's own length sets its allowance.
  assert.deepEqual(judgeTypedAnswer('leadng', { word: 'lead', forms: ['leading'] }), { kind: 'typo', typed: 'leadng', distance: 1 });
});

test('a word that is both the card\'s or a synonym and a near miss reads as the nearer truth', () => {
  // An exact listed form is correct even if it's also a synonym; a synonym beats a typo of the word.
  assert.deepEqual(judgeTypedAnswer('led', { word: 'lead', forms: ['led'], synonyms: ['led'] }), { kind: 'correct', typed: 'led' });
  assert.deepEqual(judgeTypedAnswer('beat', { word: 'bear', synonyms: ['beat'] }), { kind: 'synonym', typed: 'beat' });
});

test('the verdict line reads what was typed and how it compares', () => {
  assert.equal(verdictLine({ kind: 'empty' }, 'crestfallen'), null);
  assert.deepEqual(verdictLine({ kind: 'correct', typed: 'crestfallen' }, 'crestfallen'), { text: '✓ crestfallen', tone: 'correct' });
  assert.deepEqual(verdictLine({ kind: 'typo', typed: 'crestfalen', distance: 1 }, 'crestfallen'), { text: '≈ crestfalen — one letter off', tone: 'close' });
  assert.deepEqual(verdictLine({ kind: 'typo', typed: 'cretsfalen', distance: 2 }, 'crestfallen'), { text: '≈ cretsfalen — two letters off', tone: 'close' });
  assert.deepEqual(verdictLine({ kind: 'synonym', typed: 'downcast' }, 'crestfallen'), { text: '↔ downcast is a synonym — this card is crestfallen', tone: 'close' });
  assert.deepEqual(verdictLine({ kind: 'wrong', typed: 'dejected' }, 'crestfallen'), { text: '✗ dejected', tone: 'wrong' });
});
