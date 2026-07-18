#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [inputArg, outputArg, workArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error('Usage: audit-corpus.mjs <corpus-export.json> <manifest.json> [work-directory]');
}

const MODEL = 'gpt-5.6-sol';
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
        required: ['itemId', 'audit', 'imagePrompt', 'cards', 'sentence'],
        properties: {
          itemId: { type: 'string' },
          audit: { $ref: '#/$defs/audit' },
          imagePrompt: { type: 'string' },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['cardId', 'audit', 'imagePrompt', 'examples'],
              properties: {
                cardId: { type: 'string' },
                audit: { $ref: '#/$defs/audit' },
                imagePrompt: { type: 'string' },
                examples: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['index', 'action', 'replacement', 'reason'],
                    properties: {
                      index: { type: 'integer', minimum: 0 },
                      action: { type: 'string', enum: ['keep', 'rewrite', 'remove'] },
                      replacement: { type: 'string' },
                      reason: { type: 'string' },
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
              replacement: { type: 'string' },
              reason: { type: 'string' },
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
        reason: { type: 'string' },
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

Return one result for every supplied item, in the same order. Be conservative but decisive, and return only schema-valid JSON.`;

function compactRecord(record) {
  const data = record.data || {};
  if (record.type === 'vocab') {
    return {
      itemId: record.id,
      type: record.type,
      item: { word: data.word, sense: data.sense, chinese: data.chinese, definition: data.definition, register: data.register },
      cards: [{
        cardId: data.id, word: data.word, sense: data.sense, chinese: data.chinese,
        definition: data.definition, register: data.register, examples: data.examples || [],
      }],
    };
  }
  if (record.type === 'phrase') {
    return {
      itemId: record.id,
      type: record.type,
      item: { query: data.query, translation: data.translation, grammar: data.grammar, originalQuery: data.originalQuery },
      cards: (data.vocabs || []).map(card => ({
        cardId: card.id, word: card.word, sense: card.sense, chinese: card.chinese,
        definition: card.definition, register: card.register, examples: card.examples || [],
      })),
    };
  }
  return {
    itemId: record.id,
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
    if (batch.length > 0 && (batch.length >= 6 || chars + size > 45_000)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push({ source: item, compact });
    chars += size;
  }
  if (batch.length > 0) batches.push(batch);
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
  return batch.map(({ source, compact }, index) => {
    const result = parsed.results[index];
    if (result.itemId !== source.id) throw new Error(`Result order/id mismatch for ${source.id}`);
    validateAudit(result.audit, source.id);
    if (source.type === 'sentence' ? result.imagePrompt !== '' : !result.imagePrompt.trim()) {
      throw new Error(`${source.id}: invalid item image prompt`);
    }
    const expectedCards = compact.cards;
    if (!Array.isArray(result.cards) || result.cards.length !== expectedCards.length) {
      throw new Error(`${source.id}: model returned the wrong card count`);
    }
    for (let cardIndex = 0; cardIndex < expectedCards.length; cardIndex++) {
      const expected = expectedCards[cardIndex];
      const actual = result.cards[cardIndex];
      if (actual.cardId !== expected.cardId) throw new Error(`${source.id}: card id/order mismatch`);
      validateAudit(actual.audit, `${source.id}/${expected.cardId}`);
      if (typeof actual.imagePrompt !== 'string' || !actual.imagePrompt.trim()) {
        throw new Error(`${source.id}/${expected.cardId}: invalid card image prompt`);
      }
      if (!Array.isArray(actual.examples) || actual.examples.length !== expected.examples.length) {
        throw new Error(`${source.id}/${expected.cardId}: wrong example decision count`);
      }
      actual.examples.forEach((decision, exampleIndex) => {
        if (decision.index !== exampleIndex) throw new Error(`${source.id}/${expected.cardId}: example index mismatch`);
        if (decision.action === 'rewrite' && !decision.replacement.trim()) {
          throw new Error(`${source.id}/${expected.cardId}: empty example rewrite`);
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
    return result;
  });
}

function runBatch(batch, index) {
  const fingerprint = createHash('sha256').update(JSON.stringify(batch.map(entry => entry.compact))).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `batch-${String(index + 1).padStart(4, '0')}-${fingerprint}.json`);
  if (!existsSync(resultPath)) {
    const prompt = `${instruction}\n\nAUDIT THESE RECORDS:\n${JSON.stringify(batch.map(entry => entry.compact))}`;
    execFileSync('/usr/local/bin/codex', [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
      '-m', MODEL, '-c', 'model_reasoning_effort="high"', '--output-schema', schemaPath, '-o', resultPath, '-'
    ], { input: prompt, stdio: ['pipe', 'inherit', 'inherit'], timeout: 45 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
  }
  return validateResult(batch, JSON.parse(readFileSync(resultPath, 'utf8')));
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
for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
  process.stderr.write(`Auditing batch ${batchIndex + 1}/${batches.length}\n`);
  const batch = batches[batchIndex];
  const results = runBatch(batch, batchIndex);
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
      archiveForUsage: archiveFor(result.audit),
    });
  }
}

const manifest = { version: 1, generatedAt: auditedAt, model: MODEL, entries };
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Wrote ${entries.length} audited item(s) to ${outputPath}\n`);
