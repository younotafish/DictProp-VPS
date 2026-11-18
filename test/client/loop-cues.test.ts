import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clozeText,
  cueLevel,
  firstLetters,
  loopCard,
  markExpression,
  SENTENCE_GOT_IT_RULE,
  sourceFormsLookup,
} from '../../services/learningLoop/cues.ts';
import { maskAnswer } from '../../services/studyPrompt.ts';
import { practicing, reviewed, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const T = new Date(2026, 10, 18, 9).getTime();

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

test('the blanks are where maskAnswer puts them, so a cue never shows what a study prompt hides', () => {
  const cases: [text: string, word: string, forms?: string[]][] = [
    ['Run, run! He ran off running.', 'run', ['ran', 'runs, running']],
    ['The teacher\'s notes were gone.', 'teacher', ['teachers']],
    ['He gave up smoking and gives up nothing else.', 'give up', ['gave up', 'gives up']],
    ['A stray -s form leaves it\'s alone.', 'cat', ['-s']],
    ['Café owners love the café.', 'café'],
  ];
  for (const [text, word, forms] of cases) {
    const parts = markExpression(text, word, forms);
    assert.equal(parts ? clozeText(parts) : text, maskAnswer(text, word, forms), text);
  }
});

test('a hint shows each word\'s first letter and the shape of the rest', () => {
  assert.equal(firstLetters('come down with'), 'c___ d___ w___');
  assert.equal(firstLetters('don\'t'), 'd__\'_');
  assert.equal(firstLetters('well-being'), 'w___-b____');
  assert.equal(firstLetters('24/7 Café'), '24/7 C___');
  assert.equal(firstLetters('I'), 'I');
});

test('the cue moves to level 2 once a reviewed item\'s stability reaches six days', () => {
  assert.equal(cueLevel(vocabItem('n', 'new', { srs: { stability: 20 } })), 1, 'new, whatever its seed stability');
  assert.equal(cueLevel(vocabItem('r', 'r', { srs: reviewed(T, { stability: 5.9 }) })), 1);
  assert.equal(cueLevel(vocabItem('r', 'r', { srs: reviewed(T, { stability: 6 }) })), 2);
  assert.equal(cueLevel(vocabItem('p', 'p', { srs: practicing(T, { stability: 18 }) })), 2);
});

type VocabOptions = NonNullable<Parameters<typeof vocabItem>[2]>;
const crestfallen = (srs?: VocabOptions['srs'], extra: VocabOptions = {}) => vocabItem('w', 'crestfallen', {
  sense: 'adjective: sad and disappointed',
  chinese: '垂头丧气的（crestfallen）',
  definition: 'Looking crestfallen, sad and disappointed.',
  ipa: '/ˈkrestˌfɔːlən/',
  examples: ['', 'He looked {{crestfallen}} after the loss.', 'Nobody knew why.', 'She was crestfallen at the news.'],
  ...extra,
  ...(srs ? { srs } : {}),
});

test('a word\'s level 1 cue is its Chinese, its definition with the word blanked, its part of speech and its picture', () => {
  const card = loopCard(crestfallen(undefined, { imageUrl: 'idb:stored' }), 'speak');
  assert.deepEqual(card.cue, {
    kind: 'word', level: 1, chinese: '垂头丧气的（_____）', definition: 'Looking _____, sad and disappointed.',
    partOfSpeech: 'adjective', imageUrl: 'idb:stored',
  });
  assert.equal(card.prompt, 'Say the word');
  assert.equal(card.note, undefined);
  assert.deepEqual(card.hint, { kind: 'letters', text: 'c__________' });
  assert.deepEqual(card.answer, {
    kind: 'word', word: 'crestfallen', ipa: '/ˈkrestˌfɔːlən/', sense: 'adjective: sad and disappointed',
    chinese: '垂头丧气的（crestfallen）', definition: 'Looking crestfallen, sad and disappointed.',
    example: {
      parts: [{ text: 'He looked ', target: false }, { text: 'crestfallen', target: true }, { text: ' after the loss.', target: false }],
      text: 'He looked crestfallen after the loss.',
    },
  });
  assert.equal(loopCard(crestfallen(), 'quiet').prompt, 'Think of the word');
  assert.equal('imageUrl' in loopCard(crestfallen(), 'speak').cue, false, 'no picture to show');
  const bare = loopCard(vocabItem('b', 'bare'), 'speak');
  assert.equal('example' in bare.answer, false, 'a card without examples');
});

test('a word\'s level 2 cue takes the blankable examples in turn, one more each review, and its answer shows that one', () => {
  const at = (totalReviews: number) => loopCard(crestfallen(practicing(T, { stability: 8, totalReviews })), 'speak');
  const examples = [2, 3, 4].map(reviews => {
    const { cue } = at(reviews);
    assert.equal(cue.kind === 'word' && cue.level, 2);
    return cue.kind === 'word' && cue.level === 2 ? clozeText(cue.example) : '';
  });
  // 'Nobody knew why.' can't be blanked, so it is never the cue.
  assert.deepEqual(examples, ['He looked _____ after the loss.', 'She was _____ at the news.', 'He looked _____ after the loss.']);
  const third = at(3);
  assert.equal(third.prompt, 'Say the sentence');
  assert.equal(loopCard(crestfallen(practicing(T, { stability: 8, totalReviews: 3 })), 'quiet').prompt, 'Think of the sentence');
  assert.equal(third.answer.kind === 'word' && third.answer.example?.text, 'She was crestfallen at the news.');
  assert.deepEqual(third.cue.kind === 'word' && third.cue.level === 2 && third.cue.chinese, '垂头丧气的（_____）');
  // Without a blankable example the cue stays at level 1.
  const plain = vocabItem('p', 'plain', { examples: ['Nothing here.'], srs: practicing(T, { stability: 8 }) });
  assert.equal(loopCard(plain, 'speak').cue.level, 1);
});

test('a sentence\'s level 1 cue is its translation and the sentence with the expression blanked, and its hint the expression\'s first letters', () => {
  const item = sentenceItem('s', 'She {{soaked up}} the [[sun]].', {
    sourceWord: 'soak up', translation: '她晒着太阳。', fastIpa: 'ʃi ˈsoʊkt ʌp ðə sʌn', naturalSpeechIpa: 'old',
  });
  const card = loopCard(item, 'speak');
  const parts = [{ text: 'She ', target: false }, { text: 'soaked up', target: true }, { text: ' the sun.', target: false }];
  assert.deepEqual(card.cue, { kind: 'sentence', level: 1, translation: '她晒着太阳。', sentence: parts });
  assert.equal(card.prompt, 'Say the whole sentence');
  assert.equal(card.note, SENTENCE_GOT_IT_RULE);
  assert.deepEqual(card.hint, { kind: 'letters', text: 's_____ u_' });
  assert.deepEqual(card.answer, { kind: 'sentence', parts, text: 'She soaked up the sun.', translation: '她晒着太阳。', ipa: 'ʃi ˈsoʊkt ʌp ðə sʌn' });
  assert.equal(loopCard(item, 'quiet').prompt, 'Think of the whole sentence');
  // Two marked parts: the hint gives both.
  assert.deepEqual(loopCard(sentenceItem('g', '{{Give}} it {{up}}.'), 'speak').hint, { kind: 'letters', text: 'G___ … u_' });
});

test('an unmarked sentence finds its source word or the source card\'s forms; with neither it is asked from its translation', () => {
  const unmarked = sentenceItem('s', 'They ran out of milk.', { sourceWord: 'run out of', translation: '他们的牛奶用完了。', naturalSpeechIpa: 'ðeɪ ˈræn aʊt əv mɪlk' });
  const withForms = loopCard(unmarked, 'speak', ['ran out of', 'runs out of']);
  assert.equal(withForms.cue.level, 1);
  assert.equal(withForms.cue.kind === 'sentence' && withForms.cue.level === 1 && clozeText(withForms.cue.sentence), 'They _____ milk.');
  assert.equal(withForms.answer.kind === 'sentence' && withForms.answer.ipa, 'ðeɪ ˈræn aʊt əv mɪlk', 'the legacy connected-speech IPA');

  const card = loopCard(unmarked, 'speak');
  assert.deepEqual(card.cue, { kind: 'sentence', level: 2, translation: '他们的牛奶用完了。' });
  assert.equal(card.prompt, 'Say it in English with the expression');
  assert.equal(card.note, undefined);
  assert.deepEqual(card.hint, { kind: 'letters', text: 'T___ r__ o__ o_ m___.' });
  assert.deepEqual(card.answer.kind === 'sentence' && card.answer.parts, [{ text: 'They ran out of milk.', target: false }]);
  assert.equal(loopCard(unmarked, 'quiet').prompt, 'Think of it in English with the expression');
});

test('a sentence\'s level 2 cue is its translation and picture, and its hint the level 1 cloze', () => {
  const item = sentenceItem('s', 'She {{soaked up}} the sun.', {
    translation: '她晒着太阳。', imageUrl: 'server:has_image:3', srs: practicing(T, { stability: 9 }),
  });
  const card = loopCard(item, 'speak');
  assert.deepEqual(card.cue, { kind: 'sentence', level: 2, translation: '她晒着太阳。', imageUrl: 'server:has_image:3' });
  assert.equal(card.hint.kind === 'cloze' && clozeText(card.hint.parts), 'She _____ the sun.');
  assert.equal('ipa' in card.answer, false, 'no pronunciation guide yet');
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
  // Without a sense, the first card with the word: its forms find the expression to blank.
  const sentence = sentenceItem('s4', 'They ran out of milk.', { sourceWord: 'run out of' });
  const card = loopCard(sentence, 'speak', formsOf(sentence));
  assert.equal(card.cue.kind === 'sentence' && card.cue.level === 1 && clozeText(card.cue.sentence), 'They _____ milk.');
});
