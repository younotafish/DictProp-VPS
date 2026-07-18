#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: audit-corpus.mjs <corpus-export.json> <manifest.json> [work-directory]');
}

const MODEL = 'gpt-5.6-sol';
const independentReview = process.env.AUDIT_REVIEW_PASS === '1';
const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'audit-work'));
mkdirSync(workDir, { recursive: true });

const source = JSON.parse(readFileSync(inputPath, 'utf8'));
if (source?.version !== 1 || !Array.isArray(source.items) || source.items.length === 0) {
  throw new Error('Corpus export is invalid or empty');
}

const statuses = ['modern_american', 'current_general', 'british_only', 'rare_or_dated', 'narrow_specialized'];
const confidences = ['high', 'medium', 'low'];
const auditSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemIndex', 'audit', 'imagePrompt', 'cards', 'sentence'],
        properties: {
          itemIndex: { type: 'integer', minimum: 0 },
          audit: { $ref: '#/$defs/audit' },
          imagePrompt: { type: 'string', maxLength: 1_200 },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['cardIndex', 'audit', 'imagePrompt', 'examples'],
              properties: {
                cardIndex: { type: 'integer', minimum: 0 },
                audit: { $ref: '#/$defs/audit' },
                imagePrompt: { type: 'string', maxLength: 1_200 },
                examples: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['index', 'action', 'replacement', 'reason'],
                    properties: {
                      index: { type: 'integer', minimum: 0 },
                      action: { type: 'string', enum: ['keep', 'rewrite', 'remove'] },
                      replacement: { type: 'string', maxLength: 1_000 },
                      reason: { type: 'string', maxLength: 300 },
                    },
                  },
                },
              },
            },
          },
          sentence: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'replacement', 'reason'],
            properties: {
              action: { type: 'string', enum: ['not_applicable', 'keep', 'rewrite'] },
              replacement: { type: 'string', maxLength: 2_000 },
              reason: { type: 'string', maxLength: 300 },
            },
          },
        },
      },
    },
  },
  $defs: {
    audit: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'reason', 'confidence'],
      properties: {
        status: { type: 'string', enum: statuses },
        reason: { type: 'string', maxLength: 500 },
        confidence: { type: 'string', enum: confidences },
      },
    },
  },
};
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(auditSchema, null, 2)}\n`, { mode: 0o600 });

const instruction = `You are a senior American English lexicographer performing a thorough audit of a private ESL corpus.

The learner wants useful, contemporary, broadly understood American English. Audit the EXACT sense on each card, not merely the spelling.

Classify every item and every card as exactly one of:
- modern_american: normal and useful in present-day American English, including informal American usage.
- current_general: normal current English used in the United States and other major varieties.
- british_only: this exact sense or wording is British and is not normal contemporary American usage.
- rare_or_dated: obsolete, archaic, literary-only, or so infrequent that an ESL learner should not spend review time on it.
- narrow_specialized: confined mainly to a small profession, technical field, region, or subculture and not useful for general American English.

Do not label something low-value merely because it is formal, advanced, or also used in Britain. A common technical word known by ordinary educated Americans is not automatically narrow_specialized. Base frequency judgments on the exact definition, part of speech, collocation, and register shown. The reason must tell the learner where they would realistically encounter this sense and, for British-only wording, name the normal modern American equivalent when one exists. When genuinely uncertain, use low confidence; low-confidence exclusions will be kept.

Audit EVERY supplied example by its numeric index. Keep natural present-day American examples. Rewrite examples that are British, dated, unnatural, misleading, ungrammatical, or fail to demonstrate the exact definition. Remove only duplicates or examples for which no honest replacement can demonstrate this exact sense. A rewrite must sound like something an American would naturally say, make the target meaning inferable from context, preserve the intended exact sense and grammatical form, and retain {{studied target}} and [[uncommon lookup term]] markup. Do not wrap ordinary words in new markup.

For a phrase item, audit the top-level query and every nested vocabulary card. For a saved sentence, use sentence.action=keep or rewrite; preserve sourceWord/sourceSense and the intended exact meaning. Use sentence.action=not_applicable for non-sentence items. For non-sentence items, return cards for every supplied card; for sentence items, cards must be empty.

For each non-sentence item and card, write a production-ready imagePrompt for one realistic 16:9 photograph that directly depicts the exact contextual meaning. Apply this test: a learner who sees the image beside the target should be able to infer why this exact sense applies, not merely recognize its general topic. Put the diagnostic action, contrast, spatial relation, emotion, or consequence in the foreground. Keep the cast and scene simple enough to read instantly. For abstract senses, use one natural everyday situation that demonstrates the meaning without decorative symbolism. For figurative language, depict the intended modern meaning rather than a misleading literal etymology. Specify camera distance, composition, and natural lighting. Explicitly prohibit animation, illustration, 3D rendering, collage, split screens, visible text, captions, logos, and watermarks. A sentence item must use an empty imagePrompt because it is enriched separately.

Copy each itemIndex and cardIndex exactly. Keep audit reasons under 45 words, example-decision reasons under 20 words, and image prompts under 110 words. Return one result for every supplied item. Be conservative but decisive, and return only schema-valid JSON.`;
const reviewInstruction = independentReview
  ? `\n\nThis is an independent verification pass. Re-evaluate every exact sense, sentence, and example from first principles. Do not assume an earlier auditor's decision, and do not make cosmetic rewrites when the original is already natural, accurate modern American English.`
  : '';

function compactRecord(record) {
  const data = record.data || {};
  if (record.type === 'vocab') {
    return {
      type: record.type,
      item: { word: data.word, sense: data.sense, chinese: data.chinese, definition: data.definition, register: data.register },
      cards: [{
        cardIndex: 0, word: data.word, sense: data.sense, chinese: data.chinese,
        definition: data.definition, register: data.register, examples: data.examples || [],
      }],
    };
  }
  if (record.type === 'phrase') {
    return {
      type: record.type,
      item: { query: data.query, translation: data.translation, grammar: data.grammar, originalQuery: data.originalQuery },
      cards: (data.vocabs || []).map((card, cardIndex) => ({
        cardIndex, word: card.word, sense: card.sense, chinese: card.chinese,
        definition: card.definition, register: card.register, examples: card.examples || [],
      })),
    };
  }
  return {
    type: record.type,
    item: { text: data.text, sourceWord: data.sourceWord, sourceSense: data.sourceSense },
    cards: [],
  };
}

function makeBatches(items) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const item of items) {
    const compact = compactRecord(item);
    const size = JSON.stringify(compact).length;
    if (batch.length > 0 && (batch.length >= 20 || chars + size > 60_000)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push({ source: item, compact });
    chars += size;
  }
  if (batch.length > 0) batches.push(batch);
  for (const entries of batches) {
    entries.forEach((entry, itemIndex) => { entry.compact.itemIndex = itemIndex; });
  }
  return batches;
}

function validateAudit(audit, context) {
  if (!audit || !statuses.includes(audit.status) || !confidences.includes(audit.confidence) ||
      typeof audit.reason !== 'string' || !audit.reason.trim()) {
    throw new Error(`${context}: invalid usage audit`);
  }
}

function validateResult(batch, parsed) {
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== batch.length) {
    throw new Error('Model returned the wrong result count');
  }
  const resultByIndex = new Map(parsed.results.map(result => [result.itemIndex, result]));
  if (resultByIndex.size !== batch.length) throw new Error('Model returned duplicate item indexes');
  return batch.map(({ source, compact }, itemIndex) => {
    const result = resultByIndex.get(itemIndex);
    if (!result) throw new Error(`Model omitted item index ${itemIndex} (${source.id})`);
    validateAudit(result.audit, source.id);
    if (source.type === 'sentence' ? result.imagePrompt !== '' : !result.imagePrompt.trim()) {
      throw new Error(`${source.id}: invalid item image prompt`);
    }
    const expectedCards = compact.cards;
    if (!Array.isArray(result.cards) || result.cards.length !== expectedCards.length) {
      throw new Error(`${source.id}: model returned the wrong card count`);
    }
    const cardByIndex = new Map(result.cards.map(card => [card.cardIndex, card]));
    if (cardByIndex.size !== expectedCards.length) throw new Error(`${source.id}: duplicate card indexes`);
    const orderedCards = [];
    for (let cardIndex = 0; cardIndex < expectedCards.length; cardIndex++) {
      const expected = expectedCards[cardIndex];
      const actual = cardByIndex.get(cardIndex);
      if (!actual) throw new Error(`${source.id}: model omitted card index ${cardIndex}`);
      orderedCards.push(actual);
      validateAudit(actual.audit, `${source.id}/card-${cardIndex}`);
      if (typeof actual.imagePrompt !== 'string' || !actual.imagePrompt.trim()) {
        throw new Error(`${source.id}/card-${cardIndex}: invalid card image prompt`);
      }
      if (!Array.isArray(actual.examples) || actual.examples.length !== expected.examples.length) {
        throw new Error(`${source.id}/card-${cardIndex}: wrong example decision count`);
      }
      actual.examples.forEach((decision, exampleIndex) => {
        if (decision.index !== exampleIndex) throw new Error(`${source.id}/card-${cardIndex}: example index mismatch`);
        if (decision.action === 'rewrite' && !decision.replacement.trim()) {
          throw new Error(`${source.id}/card-${cardIndex}: empty example rewrite`);
        }
      });
    }
    if (source.type === 'sentence') {
      if (!['keep', 'rewrite'].includes(result.sentence.action)) throw new Error(`${source.id}: invalid sentence action`);
      if (result.sentence.action === 'rewrite' && !result.sentence.replacement.trim()) {
        throw new Error(`${source.id}: empty sentence rewrite`);
      }
    } else if (result.sentence.action !== 'not_applicable') {
      throw new Error(`${source.id}: unexpected sentence decision`);
    }
    return { ...result, cards: orderedCards };
  });
}

function runCodex(args, prompt) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/usr/local/bin/codex', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let hardKillTimeout;
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      hardKillTimeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, 12 * 60 * 1000);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(hardKillTimeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex exited with ${code ?? signal}: ${stderr}`));
    });
    child.stdin.end(prompt);
  });
}

function resultPathFor(batch, index) {
  const fingerprint = createHash('sha256').update(JSON.stringify(batch.map(entry => entry.compact))).digest('hex').slice(0, 16);
  return join(workDir, `batch-${String(index + 1).padStart(4, '0')}-${fingerprint}.json`);
}

async function runBatch(batch, index) {
  const resultPath = resultPathFor(batch, index);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) {
        const prompt = `${instruction}${reviewInstruction}${correction}\n\nAUDIT THESE RECORDS:\n${JSON.stringify(batch.map(entry => entry.compact))}`;
        await runCodex([
          'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
          '-m', MODEL, '--output-schema', schemaPath, '-o', resultPath, '-'
        ], prompt);
      }
      return validateResult(batch, JSON.parse(readFileSync(resultPath, 'utf8')));
    } catch (error) {
      if (attempt === 2) throw error;
      correction = `\n\nYour previous response failed validation: ${error instanceof Error ? error.message : String(error)}. Correct every identity, card, and example index; do not omit any requested decision.`;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(`Batch ${index + 1} exhausted retries`);
}

function storedAudit(audit, auditedAt, originalText) {
  return {
    status: audit.status,
    reason: audit.reason.trim().slice(0, 1_000),
    confidence: audit.confidence,
    auditedAt,
    ...(originalText ? { originalText } : {}),
  };
}

function applyExamples(original, decisions) {
  const next = [];
  for (let index = 0; index < original.length; index++) {
    const decision = decisions[index];
    if (decision.action === 'remove') continue;
    next.push(decision.action === 'rewrite' ? decision.replacement.trim() : original[index]);
  }
  return next;
}

function archiveFor(audit) {
  return audit.confidence !== 'low' && ['british_only', 'rare_or_dated', 'narrow_specialized'].includes(audit.status);
}

const auditedAt = Date.now();
const entries = [];
const batches = makeBatches(source.items);
const batchResults = new Array(batches.length);
let nextBatch = 0;
const concurrency = Math.max(1, Math.min(24, Number(process.env.CODEX_CONCURRENCY || 12)));
const assembleOnly = process.env.AUDIT_ASSEMBLE_ONLY === '1';
async function auditWorker() {
  for (;;) {
    const batchIndex = nextBatch++;
    if (batchIndex >= batches.length) return;
    process.stderr.write(`Auditing batch ${batchIndex + 1}/${batches.length}\n`);
    batchResults[batchIndex] = await runBatch(batches[batchIndex], batchIndex);
  }
}
if (assembleOnly) {
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const resultPath = resultPathFor(batches[batchIndex], batchIndex);
    if (!existsSync(resultPath)) continue;
    try {
      batchResults[batchIndex] = validateResult(
        batches[batchIndex],
        JSON.parse(readFileSync(resultPath, 'utf8')),
      );
    } catch (error) {
      process.stderr.write(`Skipping invalid completed batch ${batchIndex + 1}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
} else {
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => auditWorker()));
}

for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
  const batch = batches[batchIndex];
  const results = batchResults[batchIndex];
  if (!results) continue;
  for (let index = 0; index < batch.length; index++) {
    const sourceRecord = batch[index].source;
    const result = results[index];
    const data = structuredClone(sourceRecord.data);
    const previousSentence = sourceRecord.type === 'sentence' ? data.text : undefined;
    data.usageAudit = storedAudit(
      result.audit,
      auditedAt,
      sourceRecord.type === 'sentence' && result.sentence.action === 'rewrite' ? previousSentence : undefined,
    );
    if (sourceRecord.type === 'vocab') {
      data.usageAudit = storedAudit(result.cards[0].audit, auditedAt);
      data.imagePrompt = result.cards[0].imagePrompt.trim();
      data.examples = applyExamples(data.examples || [], result.cards[0].examples);
    } else if (sourceRecord.type === 'phrase') {
      data.imagePrompt = result.imagePrompt.trim();
      data.vocabs = data.vocabs.map((card, cardIndex) => ({
        ...card,
        usageAudit: storedAudit(result.cards[cardIndex].audit, auditedAt),
        imagePrompt: result.cards[cardIndex].imagePrompt.trim(),
        examples: applyExamples(card.examples || [], result.cards[cardIndex].examples),
      }));
    } else if (result.sentence.action === 'rewrite') {
      data.text = result.sentence.replacement.trim();
    }
    entries.push({
      id: sourceRecord.id,
      type: sourceRecord.type,
      sourceHash: sourceRecord.sourceHash,
      data,
      wasArchived: sourceRecord.wasArchived === true,
      archiveForUsage: archiveFor(data.usageAudit),
    });
  }
}

if (entries.length === 0) throw new Error('No completed audit entries were available');
const modelLabel = independentReview ? `${MODEL} (independent verification)` : MODEL;
const manifest = { version: 1, generatedAt: auditedAt, model: assembleOnly ? `${modelLabel} (partial checkpoint)` : modelLabel, entries };
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${entries.length} audited item(s) to ${outputPath}\n`);
