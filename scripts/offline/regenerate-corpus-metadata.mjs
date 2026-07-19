#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { killCodex, spawnCodex } from './codex-process.mjs';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg || !workArg) {
  throw new Error('Usage: regenerate-corpus-metadata.mjs <corpus-export-or-manifest.json> <output-manifest.json> <work-directory>');
}

const MODEL = 'gpt-5.6-sol';
const reviewPass = process.env.METADATA_REVIEW_PASS === '1';
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg);
const activeChildren = new Set();
let aborting = false;

const payload = JSON.parse(readFileSync(inputPath, 'utf8'));
const records = Array.isArray(payload?.items) ? payload.items : payload?.entries;
if (!Array.isArray(records) || records.length === 0) {
  throw new Error('Corpus input has no records');
}
for (const record of records) {
  if (!record?.id || !['vocab', 'phrase', 'sentence'].includes(record.type) || record.data?.id !== record.id) {
    throw new Error(`Invalid corpus record: ${record?.id || 'unknown'}`);
  }
  if (typeof record.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.sourceHash)) {
    throw new Error(`Invalid source hash: ${record.id}`);
  }
}

mkdirSync(workDir, { recursive: true });
const cardWorkDir = join(workDir, 'cards');
const phraseWorkDir = join(workDir, 'phrases');
mkdirSync(cardWorkDir, { recursive: true });
mkdirSync(phraseWorkDir, { recursive: true });

const usageStatuses = [
  'modern_american',
  'current_general',
  'narrow_specialized',
  'british_only',
  'rare_or_dated',
];
const confidenceLevels = ['high', 'medium', 'low'];
const usagePriority = new Map(usageStatuses.map((status, index) => [status, index]));

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const clone = value => structuredClone(value);

function normalizedSentence(value) {
  return String(value || '')
    .replace(/\{\{([^{}]+)\}\}/g, '$1')
    .replace(/\[\[([^\[\]]+)\]\]/g, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function lexicalKey(word, sense) {
  return `${normalizedSentence(word)}\u0000${normalizedSentence(sense)}`;
}

function uniqueStrings(values, field, { allowEmpty = true, max = 20 } = {}) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  if (values.length > max) throw new Error(`${field} has too many entries`);
  const output = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} contains an empty value`);
    const cleaned = value.trim();
    const key = cleaned.toLowerCase();
    if (seen.has(key)) throw new Error(`${field} contains a duplicate value`);
    seen.add(key);
    output.push(cleaned);
  }
  if (!allowEmpty && output.length === 0) throw new Error(`${field} cannot be empty`);
  return output;
}

function requiredText(value, field, min = 1, max = 4_000) {
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) {
    throw new Error(`${field} must contain ${min}-${max} characters`);
  }
  return cleaned;
}

function validateUsageAudit(value, field) {
  if (!isRecord(value) || !usageStatuses.includes(value.status) ||
      !confidenceLevels.includes(value.confidence)) {
    throw new Error(`${field} is invalid`);
  }
  return {
    status: value.status,
    reason: requiredText(value.reason, `${field}.reason`, 15, 700),
    confidence: value.confidence,
  };
}

function validateExample(value, field) {
  const example = requiredText(value, field, 20, 900);
  const targets = [...example.matchAll(/\{\{([^{}]+)\}\}/g)];
  const lookups = [...example.matchAll(/\[\[([^\[\]]+)\]\]/g)];
  if (targets.length !== 1 || !targets[0][1].trim()) {
    throw new Error(`${field} must contain exactly one nonempty {{studied target}} marker`);
  }
  if (/\[\[|\]\]/.test(targets[0][1])) throw new Error(`${field} nests a lookup marker inside the studied target`);
  if (lookups.length > 4 || lookups.some(match => !match[1].trim())) {
    throw new Error(`${field} has invalid [[advanced lookup]] markers`);
  }
  const withoutMarkers = example
    .replace(/\{\{[^{}]+\}\}/g, '')
    .replace(/\[\[[^\[\]]+\]\]/g, '');
  if (/[{}[\]]/.test(withoutMarkers)) throw new Error(`${field} has unbalanced marker syntax`);
  if (lookups.some(match => normalizedSentence(match[1]) === normalizedSentence(targets[0][1]))) {
    throw new Error(`${field} marks the studied target as an advanced lookup too`);
  }
  return example;
}

const usageAuditSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'confidence'],
  properties: {
    status: { type: 'string', enum: usageStatuses },
    reason: { type: 'string', minLength: 15, maxLength: 700 },
    confidence: { type: 'string', enum: confidenceLevels },
  },
};

const cardSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'taskIndex', 'sense', 'chinese', 'ipa', 'definition', 'forms', 'wordFamily',
          'synonyms', 'antonyms', 'confusables', 'newExamples', 'history', 'register',
          'mnemonic', 'imagePrompt', 'usageAudit',
        ],
        properties: {
          taskIndex: { type: 'integer', minimum: 0 },
          sense: { type: 'string', minLength: 3, maxLength: 160 },
          chinese: { type: 'string', minLength: 1, maxLength: 500 },
          ipa: { type: 'string', minLength: 3, maxLength: 300 },
          definition: { type: 'string', minLength: 10, maxLength: 1_500 },
          forms: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 120 } },
          wordFamily: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['word', 'pos', 'chinese'],
              properties: {
                word: { type: 'string', minLength: 1, maxLength: 120 },
                pos: { type: 'string', minLength: 1, maxLength: 80 },
                chinese: { type: 'string', minLength: 1, maxLength: 300 },
              },
            },
          },
          synonyms: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 } },
          antonyms: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 } },
          confusables: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 160 } },
          newExamples: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 20, maxLength: 900 } },
          history: { type: 'string', minLength: 20, maxLength: 1_800 },
          register: { type: 'string', minLength: 10, maxLength: 900 },
          mnemonic: { type: 'string', minLength: 10, maxLength: 900 },
          imagePrompt: { type: 'string', minLength: 50, maxLength: 1_200 },
          usageAudit: usageAuditSchema,
        },
      },
    },
  },
};

const phraseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'taskIndex', 'translation', 'grammar', 'visualKeyword', 'pronunciation',
          'imagePrompt', 'usageAudit',
        ],
        properties: {
          taskIndex: { type: 'integer', minimum: 0 },
          translation: { type: 'string', minLength: 1, maxLength: 2_000 },
          grammar: { type: 'string', minLength: 20, maxLength: 5_000 },
          visualKeyword: { type: 'string', minLength: 1, maxLength: 300 },
          pronunciation: { type: 'string', minLength: 3, maxLength: 2_000 },
          imagePrompt: { type: 'string', minLength: 50, maxLength: 1_200 },
          usageAudit: usageAuditSchema,
        },
      },
    },
  },
};

writeFileSync(join(cardWorkDir, 'output-schema.json'), `${JSON.stringify(cardSchema, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(phraseWorkDir, 'output-schema.json'), `${JSON.stringify(phraseSchema, null, 2)}\n`, { mode: 0o600 });

const savedSentences = records.filter(record => record.type === 'sentence').map(record => record.data);
const savedTextSet = new Set(savedSentences.map(sentence => normalizedSentence(sentence.text)).filter(Boolean));
const linkedSentences = new Map();
for (const sentence of savedSentences) {
  const key = lexicalKey(sentence.sourceWord, sentence.sourceSense);
  if (!linkedSentences.has(key)) linkedSentences.set(key, []);
  linkedSentences.get(key).push(sentence.text);
}

function protectedExamplesFor(card) {
  const output = [];
  const seen = new Set();
  for (const example of Array.isArray(card.examples) ? card.examples : []) {
    const key = normalizedSentence(example);
    if (key && savedTextSet.has(key) && !seen.has(key)) {
      output.push(example);
      seen.add(key);
    }
  }
  for (const sentence of linkedSentences.get(lexicalKey(card.word, card.sense)) || []) {
    const key = normalizedSentence(sentence);
    if (key && !seen.has(key)) {
      output.push(sentence);
      seen.add(key);
    }
  }
  return output;
}

function legacyCard(card) {
  return {
    sense: card.sense || '',
    chinese: card.chinese || '',
    ipa: card.ipa || '',
    definition: card.definition || '',
    forms: card.forms || [],
    wordFamily: card.wordFamily || [],
    synonyms: card.synonyms || [],
    antonyms: card.antonyms || [],
    confusables: card.confusables || [],
    examples: card.examples || [],
    history: card.history || '',
    register: card.register || '',
    mnemonic: card.mnemonic || '',
    imagePrompt: card.imagePrompt || '',
    usageAudit: card.usageAudit || null,
  };
}

const cardTasks = [];
const phraseTasks = [];
const siblingSensesByWord = new Map();
for (const record of records) {
  const cards = record.type === 'vocab' ? [record.data] : record.type === 'phrase' ? (record.data.vocabs || []) : [];
  for (const card of cards) {
    const key = normalizedSentence(card.word);
    if (!key) continue;
    if (!siblingSensesByWord.has(key)) siblingSensesByWord.set(key, []);
    siblingSensesByWord.get(key).push({
      parentId: record.id,
      cardId: card.id,
      sense: card.sense || '',
      definition: card.definition || '',
    });
  }
}

const siblingEvidenceFor = (parentId, card) =>
  (siblingSensesByWord.get(normalizedSentence(card.word)) || [])
    .filter(entry => !(entry.parentId === parentId && entry.cardId === card.id))
    .slice(0, 24)
    .map(entry => ({ sense: entry.sense, definition: entry.definition }));

for (const record of records) {
  if (record.type === 'vocab') {
    const protectedExamples = protectedExamplesFor(record.data);
    cardTasks.push({
      parentId: record.id,
      sourceType: record.type,
      cardIndex: 0,
      card: record.data,
      oldSense: record.data.sense || '',
      protectedExamples,
      newExampleCount: protectedExamples.length === 0 ? 3 : protectedExamples.length === 1 ? 2 : 1,
      compact: {
        word: record.data.word,
        exactSenseEvidence: {
          senseLabel: record.data.sense || '',
          definition: record.data.definition || '',
          examples: record.data.examples || [],
        },
        protectedExamples,
        phraseContext: '',
        ...(reviewPass ? { otherSavedSenses: siblingEvidenceFor(record.id, record.data) } : {}),
        legacyMetadata: legacyCard(record.data),
      },
    });
  } else if (record.type === 'phrase') {
    phraseTasks.push({
      parentId: record.id,
      data: record.data,
      compact: {
        query: record.data.query,
        originalQuery: record.data.originalQuery || '',
        legacyMetadata: {
          translation: record.data.translation || '',
          grammar: record.data.grammar || '',
          visualKeyword: record.data.visualKeyword || '',
          pronunciation: record.data.pronunciation || '',
          imagePrompt: record.data.imagePrompt || '',
          usageAudit: record.data.usageAudit || null,
        },
        extractedVocabulary: (record.data.vocabs || []).slice(0, 30).map(card => ({
          word: card.word,
          sense: card.sense || '',
          definition: card.definition || '',
        })),
      },
    });
    for (let cardIndex = 0; cardIndex < (record.data.vocabs || []).length; cardIndex++) {
      const card = record.data.vocabs[cardIndex];
      const protectedExamples = protectedExamplesFor(card);
      cardTasks.push({
        parentId: record.id,
        sourceType: record.type,
        cardIndex,
        card,
        oldSense: card.sense || '',
        protectedExamples,
        newExampleCount: protectedExamples.length === 0 ? 3 : protectedExamples.length === 1 ? 2 : 1,
        compact: {
          word: card.word,
          exactSenseEvidence: {
            senseLabel: card.sense || '',
            definition: card.definition || '',
            examples: card.examples || [],
          },
          protectedExamples,
          phraseContext: record.data.query,
          ...(reviewPass ? { otherSavedSenses: siblingEvidenceFor(record.id, card) } : {}),
          legacyMetadata: legacyCard(card),
        },
      });
    }
  }
}

const passContext = reviewPass
  ? `The legacyMetadata below is a newly regenerated draft from another GPT-5.6 lexicographer. Act as the final critical verifier. Retain accurate content, but correct every factual, dialect, sense, translation, IPA, etymology, register, marker, or pedagogical defect. Do not paraphrase merely for variety.`
  : `The legacyMetadata below may have been produced years ago by a weak model. Treat it only as untrusted sense evidence. Rebuild every requested field from first principles instead of polishing its wording.`;

const commonUsageInstruction = `Classify the exact sense as one of modern_american, current_general, narrow_specialized, british_only, or rare_or_dated. The learner prioritizes broadly useful present-day American English. Do not call an advanced but broadly understood word specialized merely because it is formal. Explain where this exact sense is encountered and give the normal American equivalent for British-only or low-value senses.`;

const cardInstruction = `You are the senior American English lexicographer rebuilding a private ESL card collection with the highest available accuracy.

${passContext}

Keep the supplied headword spelling as the identity, but regenerate a concise canonical sense label and every other field. Resolve conflicts in the evidence by choosing the coherent exact sense demonstrated by the sense label, definition, examples, protected examples, and phrase context. Never silently switch to a different meaning. The otherSavedSenses list shows separately stored meanings of the same spelling; make this label precise enough to remain distinct and never collapse two genuine senses into one.

Requirements:
- chinese: natural Simplified Chinese translation of this exact sense.
- ipa: one standard contemporary American IPA transcription in /slashes/ for the supplied headword or expression.
- definition: precise English definition for this sense, understandable to an advanced ESL learner.
- forms: only genuine inflected forms that differ from the supplied headword; put derivational relatives in wordFamily instead. Return an empty array for an uninflected expression.
- wordFamily: useful genuine derivatives with part of speech and Simplified Chinese meaning. Do not invent forms.
- synonyms and antonyms: sense-specific, substitutable where practical. It is correct to return no antonym when none exists.
- confusables: only words or expressions learners realistically confuse with this target.
- history: factually conservative etymology and semantic development. Never present a mnemonic or folk etymology as history; explicitly note uncertainty when appropriate.
- register: current American frequency, formality, dialect, domain, connotation, and any important usage restriction.
- mnemonic: a concise, useful memory aid that is clearly a memory aid and never a false etymological claim.
- imagePrompt: under 110 words for one realistic photorealistic 16:9 scene that makes the exact sense inferable at a glance. Foreground the diagnostic action, relation, contrast, or consequence. No illustration, animation, 3D render, metaphor unless the sense is figurative, collage, split screen, visible text, captions, logos, or watermark.
- ${commonUsageInstruction}

Examples are generated separately from protectedExamples. Return exactly newExampleCount NEW examples and never repeat or rewrite a protected example. Each new example must sound natural in present-day American English, make the exact sense inferable from context, and contain exactly one {{studied target}} marker around the target or its natural inflection. Wrap only genuinely useful C1/C2-level lookup expressions in [[double brackets]], at most four per example. Do not mark ordinary words. These markers drive clickable saved-card lookup or AI search, so they must be balanced and semantically meaningful.

Copy every taskIndex exactly and return only schema-valid JSON.`;

const phraseInstruction = `You are the senior American English lexicographer rebuilding phrase and expression metadata for a private ESL collection with the highest available accuracy.

${passContext}

Keep query unchanged as the identity. Regenerate:
- translation: accurate natural Simplified Chinese for the complete query in context.
- grammar: concise but complete Markdown explaining meaning, construction, grammar, collocation, register, and any modern American nuance. Correct any false premise in the legacy draft.
- visualKeyword: a short concrete retrieval cue, not a vague topic label.
- pronunciation: contemporary American pronunciation in IPA /slashes/; for a full sentence, provide one readable connected-speech transcription.
- imagePrompt: under 110 words for one realistic photorealistic 16:9 scene that makes the complete contextual meaning inferable at a glance. No illustration, animation, 3D render, decorative symbolism, collage, split screen, visible text, captions, logos, or watermark.
- ${commonUsageInstruction}

The extractedVocabulary is context only and is regenerated in a separate validated pass. Copy every taskIndex exactly and return only schema-valid JSON.`;

function makeBatches(tasks, maxTasks, maxChars) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const task of tasks) {
    const size = JSON.stringify(task.compact).length;
    if (batch.length > 0 && (batch.length >= maxTasks || chars + size > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(task);
    chars += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function runCodex(args, prompt) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCodex(args);
    activeChildren.add(child);
    let stderr = '';
    let hardKillTimeout;
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-30_000); });
    const timeout = setTimeout(() => {
      killCodex(child, 'SIGTERM');
      hardKillTimeout = setTimeout(() => killCodex(child, 'SIGKILL'), 10_000);
    }, 20 * 60 * 1000);
    child.on('error', error => {
      activeChildren.delete(child);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKillTimeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex exited with ${code ?? signal}: ${stderr}`));
    });
    child.stdin.end(prompt);
  });
}

function validateCardResult(task, value, context) {
  if (!isRecord(value)) throw new Error(`${context} is not an object`);
  const ipa = requiredText(value.ipa, `${context}.ipa`, 3, 300);
  if (!(ipa.startsWith('/') && ipa.endsWith('/'))) throw new Error(`${context}.ipa must use /slashes/`);
  const wordFamily = Array.isArray(value.wordFamily) ? value.wordFamily.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${context}.wordFamily[${index}] is invalid`);
    return {
      word: requiredText(entry.word, `${context}.wordFamily[${index}].word`, 1, 120),
      pos: requiredText(entry.pos, `${context}.wordFamily[${index}].pos`, 1, 80),
      chinese: requiredText(entry.chinese, `${context}.wordFamily[${index}].chinese`, 1, 300),
    };
  }) : null;
  if (!wordFamily || wordFamily.length > 12) throw new Error(`${context}.wordFamily is invalid`);
  const newExamples = uniqueStrings(value.newExamples, `${context}.newExamples`, { max: 3 })
    .map((example, index) => validateExample(example, `${context}.newExamples[${index}]`));
  if (newExamples.length !== task.newExampleCount) {
    throw new Error(`${context} returned ${newExamples.length}/${task.newExampleCount} requested new examples`);
  }
  const protectedKeys = new Set(task.protectedExamples.map(normalizedSentence));
  for (const example of newExamples) {
    if (protectedKeys.has(normalizedSentence(example))) throw new Error(`${context} repeats a protected example`);
  }
  const forms = uniqueStrings(value.forms, `${context}.forms`, { max: 12 });
  if (forms.some(form => normalizedSentence(form) === normalizedSentence(task.card.word))) {
    throw new Error(`${context}.forms repeats the unchanged headword`);
  }
  return {
    sense: requiredText(value.sense, `${context}.sense`, 3, 160),
    chinese: requiredText(value.chinese, `${context}.chinese`, 1, 500),
    ipa,
    definition: requiredText(value.definition, `${context}.definition`, 10, 1_500),
    forms,
    wordFamily,
    synonyms: uniqueStrings(value.synonyms, `${context}.synonyms`, { max: 12 }),
    antonyms: uniqueStrings(value.antonyms, `${context}.antonyms`, { max: 12 }),
    confusables: uniqueStrings(value.confusables, `${context}.confusables`, { max: 12 }),
    newExamples,
    history: requiredText(value.history, `${context}.history`, 20, 1_800),
    register: requiredText(value.register, `${context}.register`, 10, 900),
    mnemonic: requiredText(value.mnemonic, `${context}.mnemonic`, 10, 900),
    imagePrompt: requiredText(value.imagePrompt, `${context}.imagePrompt`, 50, 1_200),
    usageAudit: validateUsageAudit(value.usageAudit, `${context}.usageAudit`),
  };
}

function validatePhraseResult(_task, value, context) {
  if (!isRecord(value)) throw new Error(`${context} is not an object`);
  const pronunciation = requiredText(value.pronunciation, `${context}.pronunciation`, 3, 2_000);
  if (!(pronunciation.startsWith('/') && pronunciation.endsWith('/'))) {
    throw new Error(`${context}.pronunciation must use /slashes/`);
  }
  return {
    translation: requiredText(value.translation, `${context}.translation`, 1, 2_000),
    grammar: requiredText(value.grammar, `${context}.grammar`, 20, 5_000),
    visualKeyword: requiredText(value.visualKeyword, `${context}.visualKeyword`, 1, 300),
    pronunciation,
    imagePrompt: requiredText(value.imagePrompt, `${context}.imagePrompt`, 50, 1_200),
    usageAudit: validateUsageAudit(value.usageAudit, `${context}.usageAudit`),
  };
}

async function runTaskSet({ name, tasks, schemaPath, instruction, validator, maxTasks, maxChars, directory }) {
  if (tasks.length === 0) return [];
  const batches = makeBatches(tasks, maxTasks, maxChars);
  const results = new Array(batches.length);
  let nextBatch = 0;
  const concurrency = Math.max(1, Math.min(48, Number(process.env.CODEX_CONCURRENCY || 20)));

  const runBatch = async (batch, batchIndex) => {
    const compact = batch.map((task, taskIndex) => ({
      taskIndex,
      ...task.compact,
      ...(name === 'cards' ? { newExampleCount: task.newExampleCount } : {}),
    }));
    const fingerprint = createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 16);
    const resultPath = join(directory, `batch-${String(batchIndex + 1).padStart(4, '0')}-${fingerprint}.json`);
    let correction = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!existsSync(resultPath)) {
          await runCodex([
            'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
            '-m', MODEL, '--output-schema', schemaPath, '-o', resultPath, '-',
          ], `${instruction}${correction}\n\nREBUILD THESE ${name.toUpperCase()}:\n${JSON.stringify(compact)}`);
        }
        const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
          throw new Error(`wrong result count (${parsed.results?.length ?? 'missing'}/${batch.length})`);
        }
        const byIndex = new Map(parsed.results.map(result => [result.taskIndex, result]));
        if (byIndex.size !== batch.length) throw new Error('duplicate task indexes');
        return batch.map((task, taskIndex) => {
          const result = byIndex.get(taskIndex);
          if (!result) throw new Error(`missing taskIndex ${taskIndex}`);
          return validator(task, result, `${name} batch ${batchIndex + 1} task ${taskIndex}`);
        });
      } catch (error) {
        if (aborting || attempt === 2) throw error;
        correction = `\n\nYour previous output failed strict validation: ${error instanceof Error ? error.message : String(error)}. Return every taskIndex exactly once and correct the specific structural or content defect.`;
        if (existsSync(resultPath)) unlinkSync(resultPath);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
      }
    }
    throw new Error(`${name} batch ${batchIndex + 1} exhausted retries`);
  };

  async function worker() {
    for (;;) {
      const batchIndex = nextBatch++;
      if (batchIndex >= batches.length) return;
      process.stderr.write(`Regenerating ${name} batch ${batchIndex + 1}/${batches.length}\n`);
      results[batchIndex] = await runBatch(batches[batchIndex], batchIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  return results.flat();
}

async function terminateActiveChildren() {
  aborting = true;
  for (const child of activeChildren) killCodex(child, 'SIGTERM');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  for (const child of activeChildren) killCodex(child, 'SIGKILL');
}

let phraseResults;
let cardResults;
try {
  phraseResults = await runTaskSet({
    name: 'phrases',
    tasks: phraseTasks,
    schemaPath: join(phraseWorkDir, 'output-schema.json'),
    instruction: phraseInstruction,
    validator: validatePhraseResult,
    maxTasks: 8,
    maxChars: 45_000,
    directory: phraseWorkDir,
  });
  cardResults = await runTaskSet({
    name: 'cards',
    tasks: cardTasks,
    schemaPath: join(cardWorkDir, 'output-schema.json'),
    instruction: cardInstruction,
    validator: validateCardResult,
    maxTasks: 8,
    maxChars: 48_000,
    directory: cardWorkDir,
  });
} catch (error) {
  await terminateActiveChildren();
  throw error;
}

if (cardResults.length !== cardTasks.length || phraseResults.length !== phraseTasks.length) {
  throw new Error('Regeneration did not produce a result for every task');
}

const auditedAt = Date.now();
const storedUsageAudit = value => ({ ...value, auditedAt });
const shouldArchive = audit => audit.confidence !== 'low' &&
  ['narrow_specialized', 'british_only', 'rare_or_dated'].includes(audit.status);

const cardResultsByParent = new Map();
for (let index = 0; index < cardTasks.length; index++) {
  const task = cardTasks[index];
  if (!cardResultsByParent.has(task.parentId)) cardResultsByParent.set(task.parentId, []);
  cardResultsByParent.get(task.parentId).push({ task, result: cardResults[index] });
}
const phraseResultByParent = new Map(phraseTasks.map((task, index) => [task.parentId, phraseResults[index]]));

function regeneratedCard(task, result) {
  return {
    ...clone(task.card),
    sense: result.sense,
    chinese: result.chinese,
    ipa: result.ipa,
    definition: result.definition,
    forms: result.forms,
    wordFamily: result.wordFamily,
    synonyms: result.synonyms,
    antonyms: result.antonyms,
    confusables: result.confusables,
    examples: [...task.protectedExamples, ...result.newExamples],
    history: result.history,
    register: result.register,
    mnemonic: result.mnemonic,
    imagePrompt: result.imagePrompt,
    usageAudit: storedUsageAudit(result.usageAudit),
  };
}

const uniqueSenseChanges = new Map();
for (let index = 0; index < cardTasks.length; index++) {
  const task = cardTasks[index];
  if (task.sourceType !== 'vocab') continue;
  const key = lexicalKey(task.card.word, task.oldSense);
  if (!uniqueSenseChanges.has(key)) uniqueSenseChanges.set(key, new Set());
  uniqueSenseChanges.get(key).add(cardResults[index].sense);
}

let updatedSentenceSenseLinks = 0;
const entries = records.map(record => {
  let data = clone(record.data);
  if (record.type === 'vocab') {
    const pair = cardResultsByParent.get(record.id)?.[0];
    if (!pair) throw new Error(`Missing regenerated card ${record.id}`);
    data = regeneratedCard(pair.task, pair.result);
  } else if (record.type === 'phrase') {
    const phraseResult = phraseResultByParent.get(record.id);
    const pairs = cardResultsByParent.get(record.id) || [];
    if (!phraseResult || pairs.length !== (record.data.vocabs || []).length) {
      throw new Error(`Missing regenerated phrase content ${record.id}`);
    }
    const vocabs = pairs
      .map(pair => regeneratedCard(pair.task, pair.result))
      .map((card, index) => ({ card, index }))
      .sort((left, right) =>
        (usagePriority.get(left.card.usageAudit.status) ?? 99) -
          (usagePriority.get(right.card.usageAudit.status) ?? 99) || left.index - right.index)
      .map(entry => entry.card);
    data = {
      ...data,
      translation: phraseResult.translation,
      grammar: phraseResult.grammar,
      visualKeyword: phraseResult.visualKeyword,
      pronunciation: phraseResult.pronunciation,
      imagePrompt: phraseResult.imagePrompt,
      usageAudit: storedUsageAudit(phraseResult.usageAudit),
      vocabs,
    };
  } else if (data.sourceSense) {
    const changes = uniqueSenseChanges.get(lexicalKey(data.sourceWord, data.sourceSense));
    if (changes?.size === 1) {
      const nextSense = [...changes][0];
      if (nextSense !== data.sourceSense) {
        data.sourceSense = nextSense;
        updatedSentenceSenseLinks++;
      }
    }
  }

  const hasUsageAudit = isRecord(data.usageAudit);
  if (!hasUsageAudit && record.type !== 'sentence') throw new Error(`Missing top-level usage audit ${record.id}`);
  return {
    id: record.id,
    type: record.type,
    sourceHash: record.sourceHash,
    data,
    wasArchived: record.wasArchived === true,
    archiveForUsage: hasUsageAudit ? shouldArchive(data.usageAudit) : false,
  };
});

let protectedExampleCount = 0;
let cardsWithProtectedExamples = 0;
for (const task of cardTasks) {
  protectedExampleCount += task.protectedExamples.length;
  if (task.protectedExamples.length > 0) cardsWithProtectedExamples++;
}

const generatedAt = Date.now();
const output = {
  version: 1,
  generatedAt,
  model: `${MODEL} (${reviewPass ? 'critical metadata verification' : 'full metadata regeneration'})`,
  entries,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(dirname(outputPath), `${reviewPass ? 'review-' : ''}regeneration-report.json`), `${JSON.stringify({
  version: 1,
  generatedAt,
  model: MODEL,
  reviewPass,
  records: records.length,
  cards: cardTasks.length,
  phrases: phraseTasks.length,
  savedSentences: savedSentences.length,
  cardsWithProtectedExamples,
  protectedExampleCount,
  updatedSentenceSenseLinks,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${entries.length} records with ${cardTasks.length} regenerated cards and ${phraseTasks.length} regenerated phrases\n`);
