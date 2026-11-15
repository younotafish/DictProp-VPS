// The vocabulary-completion stage's own logic: which cards need work, what is sent for each, how an answer
// is checked, and how accepted answers are merged into their cards. complete-corpus-fields.mjs runs it.

import { createHash } from 'node:crypto';
import { errorMessage, indexedResults } from './model-stage.mjs';
import {
  hasCurrentLocalAdvancedEnrichment,
  markLocalAdvancedEnrichment,
} from './local-advanced-enrichment.mjs';
import { missingCardFields } from './vocab-card-contract.mjs';

const REQUIRED_TEXT_FIELDS = ['sense', 'chinese', 'ipa', 'definition', 'history', 'register', 'mnemonic', 'imagePrompt'];
const ARCHIVED_USAGE_STATUSES = ['british_only', 'rare_or_dated', 'narrow_specialized'];

// A card needs work when it misses a field, or when it lacks a current local advanced enrichment, in which
// case every learning field is rewritten.
export function collectCompletionTasks(entries) {
  const tasks = [];
  for (const entry of entries) {
    const cards = entry.type === 'vocab'
      ? [entry.data]
      : entry.type === 'phrase' && Array.isArray(entry.data?.vocabs)
        ? entry.data.vocabs
        : [];
    for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
      const card = cards[cardIndex];
      const missing = missingCardFields(card);
      const refreshAll = !hasCurrentLocalAdvancedEnrichment(card);
      if (missing.length === 0 && !refreshAll) continue;
      tasks.push({
        parentId: entry.id,
        parentType: entry.type,
        parentQuery: entry.type === 'phrase' ? entry.data.query : undefined,
        cardIndex,
        cardId: card.id || entry.id,
        missing,
        refreshAll,
        card,
      });
    }
  }
  return tasks;
}

// The record the model sees for one card.
export function compactTask(task, itemIndex) {
  return {
    itemIndex,
    parentType: task.parentType,
    parentQuery: task.parentQuery,
    missingFields: task.missing,
    mode: task.refreshAll ? 'advanced_rewrite' : 'repair_missing_fields',
    word: task.card.word,
    sense: task.card.sense,
    chinese: task.card.chinese,
    ipa: task.card.ipa,
    definition: task.card.definition,
    forms: task.card.forms,
    wordFamily: task.card.wordFamily,
    synonyms: task.card.synonyms,
    antonyms: task.card.antonyms,
    confusables: task.card.confusables,
    examples: task.card.examples,
    history: task.card.history,
    register: task.card.register,
    mnemonic: task.card.mnemonic,
    imagePrompt: task.card.imagePrompt,
    usageAudit: task.card.usageAudit,
  };
}

const FIELD_PROBLEMS = {
  chinese: 'chinese must be a Simplified Chinese equivalent',
  ipa: 'IPA must be one General American transcription enclosed in a single pair of slashes',
  imagePrompt: 'image prompt is missing or shorter than 50 characters',
  wordFamily: 'every wordFamily entry needs a word, a part of speech, and Simplified Chinese',
  examples: 'examples must be two sentences of at least 20 characters, each with exactly one target use in double curly braces',
  usageAudit: 'usage audit is invalid',
};

// The result is checked against the same contract the selector uses, so an accepted card is never
// selected again for the same gap.
export function validateCompletion(result, task) {
  if (!result || typeof result !== 'object') throw new Error(`${task.cardId}: result is not an object`);
  const missing = missingCardFields({ ...result, word: task.card.word }, { requireAuditedAt: false });
  if (missing.length > 0) {
    throw new Error(`${task.cardId}: ${missing.map(field => FIELD_PROBLEMS[field] || `${field} is missing or too short`).join('; ')}`);
  }
  if (result.synonyms.length === 0) throw new Error(`${task.cardId}: synonyms are empty`);
}

// A model sometimes gives alternative pronunciations as separate slash pairs; they become one transcription.
export function normalizeCompletion(result) {
  if (!result || typeof result !== 'object') return result;
  const ipa = String(result.ipa || '').trim();
  const transcriptions = ipa.match(/\/[^/\n]+\//g) || [];
  const annotations = ipa.replace(/\/[^/\n]+\//g, '').replace(/[\s;,()[\]–—-]/g, '');
  if (transcriptions.length > 1 && !annotations) {
    return {
      ...result,
      ipa: `/${transcriptions.map(value => value.slice(1, -1).trim()).join('; ')}/`,
    };
  }
  return result;
}

// One batch's answer, checked: a { task, completion } pair for every card, or an error naming the problem.
export function readCompletionResults(parsed, batch) {
  const byIndex = indexedResults(parsed, batch.length, {
    wrongCount: 'Model returned the wrong result count',
    duplicate: 'Model returned duplicate item indexes',
  });
  return batch.map((task, itemIndex) => {
    const completion = normalizeCompletion(byIndex.get(itemIndex));
    if (!completion) throw new Error(`Model omitted item index ${itemIndex}`);
    validateCompletion(completion, task);
    return { task, completion };
  });
}

function withoutImageFields(value) {
  if (Array.isArray(value)) return value.map(withoutImageFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImageFields(child)]));
}

export function corpusHash(data) {
  return createHash('sha256').update(JSON.stringify(withoutImageFields(data))).digest('hex');
}

// Fills the fields the card was missing, or every learning field when it is being rewritten, and stamps
// the advanced-enrichment marker. marker is { model, provider, generatedAt }.
export function fillCard(card, completion, { model, provider, generatedAt }) {
  const next = { ...card };
  const missing = new Set(missingCardFields(card));
  const refreshAll = !hasCurrentLocalAdvancedEnrichment(card);
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (refreshAll || missing.has(field)) next[field] = completion[field].trim();
  }
  for (const field of ['forms', 'wordFamily', 'synonyms', 'antonyms', 'confusables']) {
    if (refreshAll || missing.has(field)) next[field] = completion[field];
  }
  if (refreshAll || missing.has('examples')) {
    next.examples = completion.examples;
  }
  if (refreshAll || missing.has('usageAudit')) {
    next.usageAudit = { ...completion.usageAudit, auditedAt: generatedAt };
  }
  const filled = markLocalAdvancedEnrichment(next, model, generatedAt, provider);
  const stillMissing = missingCardFields(filled);
  if (stillMissing.length > 0) {
    throw new Error(`${card.id || card.word}: still missing ${stillMissing.join(', ')} after completion`);
  }
  return filled;
}

// Builds the output entries, each parent with its completed cards filled in. A parent is published whole or
// not at all, so one failed card holds back only its own item. failedParents maps each held-back parent to
// its first error; checkFailures lists, in order, the parents whose filled cards failed the final check.
export function applyCompletions(entries, completedTasks, failures, marker) {
  const completionByCard = new Map();
  for (const { task, completion } of completedTasks) {
    completionByCard.set(`${task.parentId}\u0000${task.cardIndex}`, completion);
  }
  const failedParents = new Map();
  for (const { task, error } of failures) {
    if (!failedParents.has(task.parentId)) failedParents.set(task.parentId, `${task.cardId}: ${error}`);
  }

  const checkFailures = [];
  const completedEntries = [];
  let completedCards = 0;
  for (const entry of entries) {
    if (failedParents.has(entry.id)) continue;
    const originalData = entry.data;
    let data = originalData;
    let appliedCards = 0;
    try {
      if (entry.type === 'vocab') {
        const completion = completionByCard.get(`${entry.id}\u00000`);
        if (completion) {
          data = fillCard(originalData, completion, marker);
          appliedCards++;
        }
      } else if (entry.type === 'phrase' && Array.isArray(originalData.vocabs)) {
        let changed = false;
        const vocabs = originalData.vocabs.map((card, cardIndex) => {
          const completion = completionByCard.get(`${entry.id}\u0000${cardIndex}`);
          if (!completion) return card;
          changed = true;
          appliedCards++;
          return fillCard(card, completion, marker);
        });
        if (changed) data = { ...originalData, vocabs };
      }
    } catch (error) {
      const message = errorMessage(error);
      checkFailures.push({ id: entry.id, message });
      failedParents.set(entry.id, message);
      continue;
    }
    completedCards += appliedCards;
    const nextEntry = {
      ...entry,
      // The previous audited target is the source for this second, resumable completion pass.
      sourceHash: corpusHash(originalData),
      data,
    };
    if (entry.type === 'vocab' && data.usageAudit) {
      nextEntry.archiveForUsage = data.usageAudit.confidence !== 'low' &&
        ARCHIVED_USAGE_STATUSES.includes(data.usageAudit.status);
    }
    completedEntries.push(nextEntry);
  }
  return { entries: completedEntries, failedParents, checkFailures, completedCards };
}
