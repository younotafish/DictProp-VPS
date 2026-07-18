#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: enrich-sentences.mjs <sentence-export.json> <manifest.json> [work-directory]');
}

const MODEL = 'gpt-5.6-sol';
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'analysis-work'));
mkdirSync(workDir, { recursive: true });

const source = JSON.parse(readFileSync(inputPath, 'utf8'));
if (source?.version !== 1 || !Array.isArray(source.sentences) || source.sentences.length === 0) {
  throw new Error('Sentence export is invalid or empty');
}

const termSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['term', 'chinese', 'ipa', 'originalMeaning', 'synonyms', 'antonyms', 'examples', 'historicalEvolution'],
  properties: {
    term: { type: 'string' },
    chinese: { type: 'string' },
    ipa: { type: 'string' },
    originalMeaning: { type: 'string' },
    synonyms: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    antonyms: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    examples: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
    historicalEvolution: { type: 'string' },
  },
};
const analysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['translation', 'americanEnglish', 'terms', 'imagePrompt'],
  properties: {
    translation: { type: 'string' },
    americanEnglish: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'explanation'],
      properties: {
        status: { type: 'string', enum: ['american', 'shared', 'not_american'] },
        explanation: { type: 'string' },
      },
    },
    terms: { type: 'array', items: termSchema, maxItems: 20 },
    imagePrompt: { type: 'string' },
  },
};
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'analysis'],
        properties: { id: { type: 'string' }, analysis: analysisSchema },
      },
    },
  },
};
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const instruction = `You are an expert American English lexicographer and an exacting coach for an advanced Chinese-speaking learner. Analyze only the supplied English sentences. Be context-specific, concise, and factually conservative.

For each sentence, return these analysis fields in this exact conceptual order:
1. translation: a precise, natural Simplified Chinese translation of the entire text that preserves tense, modality, tone, register, implied relationships, and idiomatic force rather than translating word by word.
2. americanEnglish: status must be american, shared, or not_american. In English, explain whether the wording is distinctly American, shared across major varieties, or non-American, citing concrete lexical, spelling, grammar, or idiom evidence. Do not call a universal expression American merely because Americans use it. If it is not normal American English, give the natural present-day American equivalent.
3. terms: every genuinely uncommon word, idiom, phrasal verb, or fixed phrase. For each term include its context-specific Chinese translation; rhotic General American IPA with stress marks and slashes; core contextual meaning and literal/earlier meaning when figurative; sense-matched English synonyms and antonyms; two natural modern American examples that make the meaning inferable and do not quote the source; and a concise, accurate historical evolution note. Prefer the longest phrase and never duplicate components. Do not pad with ordinary A1-B2 words. Explicitly disambiguate a likely learner confusion when the context selects one sense over another.
4. imagePrompt: a production-ready prompt for one realistic photorealistic 16:9 photograph depicting the COMPLETE sentence as one coherent concrete scene. Apply this test: the scene should let a learner infer the sentence's intended meaning, not merely its topic. Put the defining action, relationship, contrast, cause, or consequence in the foreground and include every detail needed to distinguish the intended reading. Keep the cast and composition simple enough to parse instantly. For an idiom, depict its intended contextual meaning, not a misleading literal origin. Specify camera distance, composition, and natural lighting. Require authentic anatomy, skin, materials, and contemporary details. Explicitly prohibit illustration, animation, 3D render, collage, split screen, typography, captions, logos, watermarks, and visible text.

Everything must be English except translation and each term's chinese field. Synonyms/antonyms must match the contextual sense. If no natural antonym exists, return an empty array. State uncertainty rather than inventing etymology. Return every input id once, in input order, and output only schema-valid JSON.`;

const batches = [];
for (let index = 0; index < source.sentences.length; index += 4) batches.push(source.sentences.slice(index, index + 4));

function validString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAnalysis(analysis, id) {
  if (!analysis || !validString(analysis.translation) || !validString(analysis.imagePrompt) ||
      !analysis.americanEnglish || !['american', 'shared', 'not_american'].includes(analysis.americanEnglish.status) ||
      !validString(analysis.americanEnglish.explanation) || !Array.isArray(analysis.terms) || analysis.terms.length > 20) {
    throw new Error(`${id}: invalid sentence analysis`);
  }
  for (const term of analysis.terms) {
    if (!validString(term.term) || !validString(term.chinese) || !validString(term.ipa) ||
        !validString(term.originalMeaning) || !validString(term.historicalEvolution) ||
        !Array.isArray(term.synonyms) || term.synonyms.length === 0 ||
        !Array.isArray(term.antonyms) || !Array.isArray(term.examples) || term.examples.length < 2) {
      throw new Error(`${id}: invalid term analysis`);
    }
  }
}

function runBatch(batch, index) {
  const compact = batch.map(({ id, text, sourceWord, sourceSense }) => ({ id, text, sourceWord, sourceSense }));
  const fingerprint = createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(index + 1).padStart(4, '0')}-${fingerprint}.json`);
  if (!existsSync(resultPath)) {
    const prompt = `${instruction}\n\nANALYZE THESE SENTENCES:\n${JSON.stringify(compact)}`;
    execFileSync('/usr/local/bin/codex', [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
      '-m', MODEL, '-c', 'model_reasoning_effort="high"', '--output-schema', schemaPath, '-o', resultPath, '-'
    ], { input: prompt, stdio: ['pipe', 'inherit', 'inherit'], timeout: 45 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
  }
  const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
  if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) throw new Error('Wrong analysis result count');
  parsed.results.forEach((result, resultIndex) => {
    if (result.id !== batch[resultIndex].id) throw new Error(`Sentence id/order mismatch at batch ${index + 1}`);
    validateAnalysis(result.analysis, result.id);
  });
  return parsed.results;
}

const generatedAt = Date.now();
const entries = [];
for (let index = 0; index < batches.length; index++) {
  process.stderr.write(`Analyzing sentence batch ${index + 1}/${batches.length}\n`);
  const results = runBatch(batches[index], index);
  for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
    const sourceRecord = batches[index][resultIndex];
    entries.push({
      id: sourceRecord.id,
      textHash: sourceRecord.textHash,
      analysis: results[resultIndex].analysis,
      generatedAt,
    });
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ version: 1, generatedAt, entries }, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${entries.length} sentence analyses to ${outputPath}\n`);
