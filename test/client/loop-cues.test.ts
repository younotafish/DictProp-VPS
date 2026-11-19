import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cueLevel,
  firstLetters,
  loopCard,
  markExpression,
  sourceFormsLookup,
  WHAT_COUNTS,
  type TextPart,
} from '../../services/learningLoop/cues.ts';
import { maskAnswer } from '../../services/studyPrompt.ts';
import { practicing, reviewed, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const T = new Date(2026, 10, 18, 9).getTime();

/** The parts with each target as maskAnswer's blank. */
const cloze = (parts: readonly TextPart[]) => parts.map(part => (part.target ? '_____' : part.text)).join('');

test('a {{marked}} expression is the target, wherever and however often it is marked; [[lookups]] read as plain text', () => {
  assert.deepEqual(markExpression('She {{soaked up}} the [[sun]].', 'soak up'), [
    { text: 'She ', target: false }, { text: 'soaked up', target: true }, { text: ' the sun.', target: false },
  ]);
  assert.deepEqual(markExpression('{{Give}} it {{up}}!', 'give up'), [
    { text: 'Give', target: true }, { text: ' it ', target: false }, { text: 'up', target: true }, { text: '!', target: false },
  ]);
  // The marked part wins over the word itself.
  assert.deepEqual(markExpression('Run to the {{shop}}, run.', 'run')?.filter(part => part.target), [{ text: 'shop', target: true }]);
});

test('without marks, the word or its forms are the target at word boundaries in any case, every time they occur', () => {
  assert.deepEqual(markExpression('Run, run! He ran off running.', 'run', ['ran']), [
    { text: 'Run', target: true }, { text: ', ', target: false }, { text: 'run', target: true }, { text: '! He ', target: false },
    { text: 'ran', target: true }, { text: ' off running.', target: false },
  ]);
  assert.deepEqual(markExpression('She  Soaked   up the sun.', 'soak up', ['soaked up'])?.filter(part => part.target), [{ text: 'Soaked   up', target: true }]);
  assert.deepEqual(markExpression('It’s the teacher’s pet.', 'teacher\'s pet')?.filter(part => part.target), [{ text: 'teacher’s pet', target: true }]);
  assert.equal(markExpression('Nothing to see here.', 'crestfallen'), null);
  assert.equal(markExpression('Nothing to see here.', ''), null);
  assert.equal(markExpression('', 'word'), null);
});

test('the expression is found where maskAnswer finds it, so the answer marks what a study prompt hides', () => {
  const cases: [text: string, word: string, forms?: string[]][] = [
    ['Run, run! He ran off running.', 'run', ['ran', 'runs, running']],
    ['The teacher\'s notes were gone.', 'teacher', ['teachers']],
    ['He gave up smoking and gives up nothing else.', 'give up', ['gave up', 'gives up']],
    ['A stray -s form leaves it\'s alone.', 'cat', ['-s']],
    ['Café owners love the café.', 'café'],
  ];
  for (const [text, word, forms] of cases) {
    const parts = markExpression(text, word, forms);
    assert.equal(parts ? cloze(parts) : text, maskAnswer(text, word, forms), text);
  }
});

test('a hint shows each word\'s first letter and the shape of the rest', () => {
  assert.equal(firstLetters('How was your weekend?'), 'H__ w__ y___ w______?');
  assert.equal(firstLetters('come down with'), 'c___ d___ w___');
  assert.equal(firstLetters('don\'t'), 'd__\'_');
  assert.equal(firstLetters('well-being'), 'w___-b____');
  assert.equal(firstLetters('24/7 Café'), '24/7 C___');
  assert.equal(firstLetters('I'), 'I');
});

test('the cue level moves to 2 once a reviewed sentence\'s stability reaches six days', () => {
  assert.equal(cueLevel(sentenceItem('n', 'New.', { srs: { stability: 20 } })), 1, 'never reviewed, whatever its seed stability');
  assert.equal(cueLevel(sentenceItem('r', 'Got it once.', { srs: reviewed(T, { stability: 5.9 }) })), 1);
  assert.equal(cueLevel(sentenceItem('r', 'Got it often.', { srs: reviewed(T, { stability: 6 }) })), 2);
  assert.equal(cueLevel(sentenceItem('p', 'Practiced.', { srs: practicing(T, { stability: 18 }) })), 2);
});

const EYE = sentenceItem('s', 'Could you keep {{an eye on}} my [[bag]]?', {
  sourceWord: ' keep an eye on ', translation: '你能帮我看着包吗？', fastIpa: 'kʊdʒə kiːp ən aɪ ɑn maɪ bæɡ', naturalSpeechIpa: 'old',
  imageUrl: 'server:has_image:3',
});
const EYE_PARTS = [
  { text: 'Could you keep ', target: false }, { text: 'an eye on', target: true }, { text: ' my bag?', target: false },
];

test('a level 1 cue asks for the whole sentence from its translation, with the expression to use as its anchor', () => {
  const card = loopCard(EYE, 'speak');
  assert.deepEqual(card.cue, { kind: 'sentence', level: 1, translation: '你能帮我看着包吗？', expression: 'keep an eye on' });
  assert.equal(card.prompt, 'Say the whole sentence');
  assert.equal(card.note, WHAT_COUNTS.expression);
  assert.equal(WHAT_COUNTS.expression, 'The whole sentence, the expression exact; small slips are fine');
  assert.deepEqual(card.hint, { kind: 'letters', text: 'C____ y__ k___ a_ e__ o_ m_ b__?' });
  assert.deepEqual(card.answer, {
    parts: EYE_PARTS, text: 'Could you keep an eye on my bag?', translation: '你能帮我看着包吗？', ipa: 'kʊdʒə kiːp ən aɪ ɑn maɪ bæɡ',
  });
  assert.equal(loopCard(EYE, 'quiet').prompt, 'Think of the whole sentence');
  assert.equal('imageUrl' in card.cue, false, 'the picture waits for level 2');
});

test('the anchor is the source word as saved once the sentence holds the expression, else a marked part, else none', () => {
  const anchor = (item: ReturnType<typeof sentenceItem>, forms?: string[]) => loopCard(item, 'speak', forms).cue.expression;
  // Found by its marks, the word itself, or the source card's forms: the source word shows, in the form it was saved in.
  assert.equal(anchor(sentenceItem('m', 'She {{soaked up}} the sun.', { sourceWord: 'soak up' })), 'soak up');
  assert.equal(anchor(sentenceItem('w', 'We ran out of milk.', { sourceWord: 'ran out of' })), 'ran out of');
  assert.equal(anchor(sentenceItem('f', 'They ran out of milk.', { sourceWord: 'run out of' }), ['ran out of']), 'run out of');
  // No source word: the marked text, separate marks in order.
  assert.equal(anchor(sentenceItem('o', 'Keep {{ an eye on }} it.')), 'an eye on');
  assert.equal(anchor(sentenceItem('g', '{{Give}} it {{up}}!', { sourceWord: '  ' })), 'Give … up');
  // Neither found: no anchor, and what counts doesn't speak of an expression.
  const lost = sentenceItem('l', 'They ran out of milk.', { sourceWord: 'run out of' });
  assert.equal('expression' in loopCard(lost, 'speak').cue, false);
  assert.equal(loopCard(lost, 'speak').note, WHAT_COUNTS.plain);
  assert.deepEqual(loopCard(lost, 'speak').answer.parts, [{ text: 'They ran out of milk.', target: false }]);
  assert.equal('expression' in loopCard(sentenceItem('b', 'Nothing marked here.'), 'speak').cue, false);
});

test('a level 2 cue gives the translation and the picture, never the anchor; the hint and the answer stay the same', () => {
  const strong = { ...EYE, srs: { ...EYE.srs, ...practicing(T, { stability: 9 }) } };
  const card = loopCard(strong, 'speak');
  assert.deepEqual(card.cue, { kind: 'sentence', level: 2, translation: '你能帮我看着包吗？', imageUrl: 'server:has_image:3' });
  assert.equal(card.prompt, 'Say the whole sentence');
  assert.equal(card.note, WHAT_COUNTS.expression, 'the expression still counts exactly');
  assert.deepEqual(card.hint, loopCard(EYE, 'speak').hint);
  assert.deepEqual(card.answer.parts, EYE_PARTS);
  const bare = sentenceItem('n', 'No picture {{here}}.', { srs: reviewed(T, { stability: 30 }) });
  assert.deepEqual(loopCard(bare, 'quiet').cue, { kind: 'sentence', level: 2, translation: '译文 n' });
  assert.equal(loopCard(bare, 'quiet').prompt, 'Think of the whole sentence');
  assert.equal('ipa' in loopCard(bare, 'speak').answer, false, 'no pronunciation guide yet');
});

test('the Meet asks at level 1 even a sentence Got it made strong, with its anchor and no picture', () => {
  const gotIt = { ...EYE, srs: { ...EYE.srs, ...reviewed(T, { stability: 40, totalReviews: 7 }) } };
  assert.equal(cueLevel(gotIt), 2);
  assert.equal(loopCard(gotIt, 'speak').cue.level, 2, 'a run follows the schedule');
  assert.deepEqual(loopCard(gotIt, 'speak', undefined, 1).cue, {
    kind: 'sentence', level: 1, translation: '你能帮我看着包吗？', expression: 'keep an eye on',
  });
});

test('the hint is the first letters of the whole sentence, its markers gone, whatever the level and expression', () => {
  const item = sentenceItem('h', 'How {{was}} your [[weekend]]?', { sourceWord: 'be' });
  assert.deepEqual(loopCard(item, 'speak').hint, { kind: 'letters', text: 'H__ w__ y___ w______?' });
  assert.deepEqual(loopCard(item, 'quiet', undefined, 2).hint, { kind: 'letters', text: 'H__ w__ y___ w______?' });
  assert.deepEqual(loopCard(sentenceItem('u', 'I didn’t catch that, sorry.'), 'speak').hint, { kind: 'letters', text: 'I d___’_ c____ t___, s____.' });
});

test('a sentence\'s source forms come from the card its word and sense name, through one lookup over the library', () => {
  const items = [
    vocabItem('run-verb', 'run out of', { sense: 'phrasal verb: use up', forms: ['ran out of', 'runs out of'] }),
    vocabItem('run-other', 'run out of', { sense: 'phrasal verb: leave', forms: ['bolted'] }),
    vocabItem('make-time', 'make time', { forms: ['making time'] }),
  ];
  const formsOf = sourceFormsLookup(items);
  assert.deepEqual(formsOf(sentenceItem('s1', 'They ran out of milk.', { sourceWord: 'run out of', sourceSense: 'phrasal verb: use up' })), ['ran out of', 'runs out of']);
  assert.deepEqual(formsOf(sentenceItem('s2', 'She is making time.', { sourceWord: 'making time' })), ['making time'], 'through a listed form');
  assert.equal(formsOf(sentenceItem('s3', 'Nothing.', { sourceWord: 'absent' })), undefined);
  assert.equal(formsOf(items[0]), undefined, 'a word card is its own source');
  // Without a sense, the first card with the word: its forms find the expression to mark and to anchor.
  const sentence = sentenceItem('s4', 'They ran out of milk.', { sourceWord: 'run out of' });
  const card = loopCard(sentence, 'speak', formsOf(sentence));
  assert.equal(card.cue.expression, 'run out of');
  assert.equal(cloze(card.answer.parts), 'They _____ milk.');
});
