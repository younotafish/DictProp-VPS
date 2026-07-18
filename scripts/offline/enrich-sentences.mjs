#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: enrich-sentences.mjs <sentence-export.json> <manifest.json> [work-directory]');
}

const MODEL = 'gpt-5.6-sol';
const activeChildren = new Set();
let aborting = false;
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
    term: { type: 'string', maxLength: 300 },
    chinese: { type: 'string', maxLength: 1_000 },
    ipa: { type: 'string', maxLength: 500 },
    originalMeaning: { type: 'string', maxLength: 4_000 },
    synonyms: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    antonyms: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    examples: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
    historicalEvolution: { type: 'string', maxLength: 4_000 },
  },
};
const analysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['translation', 'americanEnglish', 'terms', 'imagePrompt'],
  properties: {
    translation: { type: 'string', maxLength: 12_000 },
    americanEnglish: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'explanation'],
      properties: {
        status: { type: 'string', enum: ['american', 'shared', 'not_american'] },
        explanation: { type: 'string', maxLength: 4_000 },
      },
    },
    terms: { type: 'array', items: termSchema, maxItems: 20 },
    imagePrompt: { type: 'string', maxLength: 4_000 },
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
        required: ['itemIndex', 'analysis'],
        properties: { itemIndex: { type: 'integer', minimum: 0 }, analysis: analysisSchema },
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
3. terms: every genuinely uncommon word, idiom, phrasal verb, or fixed phrase. For each term include its context-specific Chinese translation; true rhotic General American IPA with stress marks and surrounding slashes; core contextual meaning and literal/earlier meaning when figurative; sense-matched English synonyms and antonyms; two natural modern American examples that make the meaning inferable and do not quote the source; and a concise, accurate historical evolution note. Prefer the longest phrase and never duplicate components. Do not pad with ordinary A1-B2 words. Explicitly disambiguate a likely learner confusion when the context selects one sense over another. Keep fields cleanly separated: originalMeaning must contain only meaning and semantic clarification, never examples or historical chronology; usage examples belong only in examples; etymology and dated development belong only in historicalEvolution.
4. imagePrompt: a production-ready prompt for one realistic photorealistic 16:9 photograph depicting the COMPLETE sentence as one coherent concrete scene. Apply this test: the scene should let a learner infer the sentence's intended meaning, not merely its topic. Put the defining action, relationship, contrast, cause, or consequence in the foreground and include every detail needed to distinguish the intended reading. Keep the cast and composition simple enough to parse instantly. For an idiom, depict its intended contextual meaning, not a misleading literal origin. Specify camera distance, composition, and natural lighting. Require authentic anatomy, skin, materials, and contemporary details. Explicitly prohibit illustration, animation, 3D render, collage, split screen, typography, captions, logos, watermarks, and visible text.

Everything must be English except translation and each term's chinese field. Synonyms/antonyms must match the contextual sense. If no natural antonym exists, return an empty array. State uncertainty rather than inventing etymology. Copy every itemIndex exactly, return every input once, and output only schema-valid JSON.`;

const batches = [];
for (let index = 0; index < source.sentences.length; index += 12) batches.push(source.sentences.slice(index, index + 12));

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

function runCodex(args, prompt) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/usr/local/bin/codex', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    activeChildren.add(child);
    let stderr = '';
    let hardKillTimeout;
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      hardKillTimeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
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

async function runBatch(batch, index) {
  const compact = batch.map(({ text, sourceWord, sourceSense }, itemIndex) => ({ itemIndex, text, sourceWord, sourceSense }));
  const fingerprint = createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(index + 1).padStart(4, '0')}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        const prompt = `${instruction}${correction}\n\nANALYZE THESE SENTENCES:\n${JSON.stringify(compact)}`;
        await runCodex([
          'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
          '-m', MODEL, '--output-schema', schemaPath, '-o', resultPath, '-'
        ], prompt);
      }
      const parsed = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (!Array.isArray(parsed.results) || parsed.results.length !== batch.length) throw new Error('Wrong analysis result count');
      const byIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
      if (byIndex.size !== batch.length) throw new Error('Duplicate sentence indexes');
      return batch.map((sourceRecord, itemIndex) => {
        const result = byIndex.get(itemIndex);
        if (!result) throw new Error(`Missing sentence index ${itemIndex}`);
        validateAnalysis(result.analysis, sourceRecord.id);
        return result;
      });
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      correction = `\n\nYour previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Copy every index and return a complete, schema-valid analysis for every sentence.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`Sentence batch ${index + 1} exhausted retries`);
}

const generatedAt = Date.now();
const entries = [];
const batchResults = new Array(batches.length);
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(20, Number(process.env.CODEX_CONCURRENCY || 12)));
async function analysisWorker() {
  for (;;) {
    const index = nextBatch++;
    if (index >= batches.length) return;
    process.stderr.write(`Analyzing sentence batch ${index + 1}/${batches.length}\n`);
    batchResults[index] = await runBatch(batches[index], index);
  }
}
async function terminateActiveChildren() {
  aborting = true;
  for (const child of activeChildren) child.kill('SIGTERM');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  for (const child of activeChildren) child.kill('SIGKILL');
}
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => analysisWorker()));
} catch (error) {
  await terminateActiveChildren();
  throw error;
}

for (let index = 0; index < batches.length; index++) {
  const results = batchResults[index];
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
