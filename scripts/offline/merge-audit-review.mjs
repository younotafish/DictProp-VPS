#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [exportArg, firstArg, secondArg, outputArg, adjudicationArg] = process.argv.slice(2);
if (!exportArg || !firstArg || !secondArg || !outputArg) {
  throw new Error('Usage: merge-audit-review.mjs <corpus-export.json> <first-audit.json> <second-audit.json> <final-audit.json> [third-audit.json]');
}

const source = JSON.parse(readFileSync(resolve(exportArg), 'utf8'));
const first = JSON.parse(readFileSync(resolve(firstArg), 'utf8'));
const second = JSON.parse(readFileSync(resolve(secondArg), 'utf8'));
const adjudication = adjudicationArg ? JSON.parse(readFileSync(resolve(adjudicationArg), 'utf8')) : null;
if (!Array.isArray(source.items) || !Array.isArray(first.entries) || !Array.isArray(second.entries)) {
  throw new Error('Input manifests are invalid');
}
if (adjudication && !Array.isArray(adjudication.entries)) throw new Error('Third-pass manifest is invalid');
const sourceById = new Map(source.items.map(item => [item.id, item]));
const secondById = new Map(second.entries.map(entry => [entry.id, entry]));
const adjudicationById = new Map((adjudication?.entries || []).map(entry => [entry.id, entry]));
const excluded = new Set(['british_only', 'rare_or_dated', 'narrow_specialized']);
if (sourceById.size !== source.items.length) throw new Error('Corpus export contains duplicate item ids');
const firstIds = new Set(first.entries.map(entry => entry.id));
if (firstIds.size !== first.entries.length) throw new Error('First-pass audit contains duplicate item ids');
if (firstIds.size !== sourceById.size) throw new Error('First-pass audit is not a complete corpus audit');
if (secondById.size !== second.entries.length) throw new Error('Second-pass audit contains duplicate item ids');
if (adjudicationById.size !== (adjudication?.entries || []).length) throw new Error('Third-pass audit contains duplicate item ids');
if (secondById.size !== firstIds.size) throw new Error('Second-pass audit is not a complete corpus audit');
for (const id of sourceById.keys()) {
  if (!firstIds.has(id) || !secondById.has(id)) throw new Error(`Audit pass omitted source item ${id}`);
}
for (const id of secondById.keys()) {
  if (!firstIds.has(id)) throw new Error(`Second-pass audit contains unexpected item ${id}`);
}
for (const id of adjudicationById.keys()) {
  if (!firstIds.has(id)) throw new Error(`Third-pass audit contains unexpected item ${id}`);
}

function mergeUsage(left, right) {
  const leftExcluded = excluded.has(left.status);
  const rightExcluded = excluded.has(right.status);
  if (leftExcluded === rightExcluded) {
    const confidence = left.confidence === 'low' && right.confidence === 'low'
      ? 'low'
      : left.confidence === 'high' && right.confidence === 'high'
        ? 'high'
        : 'medium';
    return { ...right, confidence };
  }
  const retained = leftExcluded ? right : left;
  return { ...retained, confidence: 'low' };
}

function adjudicateUsage(left, right, tieBreaker) {
  const leftExcluded = excluded.has(left.status);
  const rightExcluded = excluded.has(right.status);
  if (leftExcluded === rightExcluded || !tieBreaker) return mergeUsage(left, right);
  const agreeingAudit = excluded.has(tieBreaker.status) === leftExcluded ? left : right;
  return mergeUsage(agreeingAudit, tieBreaker);
}

function mergeExamples(original, left, right) {
  const originalExamples = original || [];
  const leftExamples = left || [];
  const rightExamples = right || [];
  if (leftExamples.length !== originalExamples.length || rightExamples.length !== originalExamples.length) {
    return JSON.stringify(leftExamples) === JSON.stringify(rightExamples) ? rightExamples : originalExamples;
  }
  return originalExamples.map((example, index) => {
    const leftChanged = leftExamples[index] !== example;
    const rightChanged = rightExamples[index] !== example;
    return leftChanged && rightChanged ? rightExamples[index] : example;
  });
}

function adjudicateExamples(original, left, right, tieBreaker) {
  if (!tieBreaker) return mergeExamples(original, left, right);
  const originalExamples = original || [];
  const versions = [left || [], right || [], tieBreaker || []];
  if (versions.every(examples => examples.length === originalExamples.length)) {
    return originalExamples.map((example, index) => {
      const changed = versions.filter(examples => examples[index] !== example);
      if (changed.length < 2) return example;
      for (let versionIndex = versions.length - 1; versionIndex >= 0; versionIndex--) {
        if (versions[versionIndex][index] !== example) return versions[versionIndex][index];
      }
      return example;
    });
  }
  const serialized = versions.map(examples => JSON.stringify(examples));
  if (serialized[2] === serialized[1] || serialized[2] === serialized[0]) return versions[2];
  if (serialized[0] === serialized[1]) return versions[0];
  if (serialized[2] === JSON.stringify(originalExamples)) return originalExamples;
  return originalExamples;
}

function adjudicateSentence(original, left, right, tieBreaker) {
  const versions = [left, right, ...(tieBreaker === undefined ? [] : [tieBreaker])];
  const changed = versions.filter(text => text !== original);
  const required = tieBreaker === undefined ? 2 : 2;
  if (changed.length < required) return original;
  for (let index = versions.length - 1; index >= 0; index--) {
    if (versions[index] !== original) return versions[index];
  }
  return original;
}

function mergeEntry(left) {
  const right = secondById.get(left.id);
  if (!right) throw new Error(`Second-pass audit omitted item ${left.id}`);
  const tieBreaker = adjudicationById.get(left.id);
  const original = sourceById.get(left.id);
  if (!original || right.sourceHash !== left.sourceHash || right.type !== left.type) {
    throw new Error(`Second-pass identity mismatch for ${left.id}`);
  }
  if (tieBreaker && (tieBreaker.sourceHash !== left.sourceHash || tieBreaker.type !== left.type)) {
    throw new Error(`Third-pass identity mismatch for ${left.id}`);
  }
  const data = structuredClone(left.data);
  data.usageAudit = adjudicateUsage(
    left.data.usageAudit,
    right.data.usageAudit,
    tieBreaker?.data.usageAudit,
  );
  if (left.type === 'vocab') {
    data.imagePrompt = tieBreaker?.data.imagePrompt || right.data.imagePrompt || left.data.imagePrompt;
    data.examples = adjudicateExamples(
      original.data.examples,
      left.data.examples,
      right.data.examples,
      tieBreaker?.data.examples,
    );
  } else if (left.type === 'sentence') {
    data.text = adjudicateSentence(
      original.data.text,
      left.data.text,
      right.data.text,
      tieBreaker?.data.text,
    );
    if (data.text !== original.data.text) data.usageAudit.originalText = original.data.text;
    else delete data.usageAudit.originalText;
  } else if (left.type === 'phrase') {
    data.imagePrompt = tieBreaker?.data.imagePrompt || right.data.imagePrompt || left.data.imagePrompt;
    data.vocabs = left.data.vocabs.map((vocab, index) => {
      const rightVocab = right.data.vocabs[index];
      const tieBreakerVocab = tieBreaker?.data.vocabs?.[index];
      const originalVocab = original.data.vocabs[index];
      if (!rightVocab || !originalVocab || rightVocab.id !== vocab.id) {
        throw new Error(`Second-pass phrase card mismatch for ${left.id}/${index}`);
      }
      if (tieBreaker && (!tieBreakerVocab || tieBreakerVocab.id !== vocab.id)) {
        throw new Error(`Third-pass phrase card mismatch for ${left.id}/${index}`);
      }
      return {
        ...vocab,
        usageAudit: adjudicateUsage(vocab.usageAudit, rightVocab.usageAudit, tieBreakerVocab?.usageAudit),
        imagePrompt: tieBreakerVocab?.imagePrompt || rightVocab.imagePrompt || vocab.imagePrompt,
        examples: adjudicateExamples(
          originalVocab.examples,
          vocab.examples,
          rightVocab.examples,
          tieBreakerVocab?.examples,
        ),
      };
    });
  }
  const archiveForUsage = data.usageAudit.confidence !== 'low' && excluded.has(data.usageAudit.status);
  return { ...left, data, archiveForUsage };
}

const entries = first.entries.map(mergeEntry);
const final = {
  ...first,
  generatedAt: Date.now(),
  model: adjudication
    ? `${first.model} (two-pass consensus with independent adjudication)`
    : `${first.model} (independent second-pass consensus)`,
  entries,
};
writeFileSync(resolve(outputArg), `${JSON.stringify(final, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Merged ${second.entries.length} independently reviewed item(s)` +
  `${adjudication ? ` with ${adjudication.entries.length} adjudication(s)` : ''} into ${entries.length} final audit entries\n`);
