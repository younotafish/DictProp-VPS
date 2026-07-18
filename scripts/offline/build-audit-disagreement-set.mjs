#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [exportArg, firstArg, secondArg, outputArg] = process.argv.slice(2);
if (!exportArg || !firstArg || !secondArg || !outputArg) {
  throw new Error('Usage: build-audit-disagreement-set.mjs <corpus-export.json> <first-audit.json> <second-audit.json> <output.json>');
}

const source = JSON.parse(readFileSync(resolve(exportArg), 'utf8'));
const first = JSON.parse(readFileSync(resolve(firstArg), 'utf8'));
const second = JSON.parse(readFileSync(resolve(secondArg), 'utf8'));
if (!Array.isArray(source.items) || !Array.isArray(first.entries) || !Array.isArray(second.entries)) {
  throw new Error('Input manifests are invalid');
}

const firstById = new Map(first.entries.map(entry => [entry.id, entry]));
const secondById = new Map(second.entries.map(entry => [entry.id, entry]));
if (firstById.size !== source.items.length || secondById.size !== source.items.length) {
  throw new Error('Both audit passes must cover the complete corpus');
}
const excluded = new Set(['british_only', 'rare_or_dated', 'narrow_specialized']);
const isExcluded = audit => excluded.has(audit?.status);

function examplesDisagree(original, left, right) {
  const base = original || [];
  const firstExamples = left || [];
  const secondExamples = right || [];
  if (firstExamples.length !== base.length || secondExamples.length !== base.length) {
    return JSON.stringify(firstExamples) !== JSON.stringify(secondExamples);
  }
  return base.some((example, index) =>
    (firstExamples[index] !== example) !== (secondExamples[index] !== example));
}

function needsAdjudication(sourceItem, left, right) {
  if (!left || !right || left.type !== sourceItem.type || right.type !== sourceItem.type ||
      left.sourceHash !== sourceItem.sourceHash || right.sourceHash !== sourceItem.sourceHash) {
    throw new Error(`Audit identity mismatch for ${sourceItem.id}`);
  }
  if (isExcluded(left.data.usageAudit) !== isExcluded(right.data.usageAudit)) return true;
  if (sourceItem.type === 'vocab') {
    return examplesDisagree(sourceItem.data.examples, left.data.examples, right.data.examples);
  }
  if (sourceItem.type === 'sentence') {
    return (left.data.text !== sourceItem.data.text) !== (right.data.text !== sourceItem.data.text);
  }
  const originalCards = sourceItem.data.vocabs || [];
  const leftCards = left.data.vocabs || [];
  const rightCards = right.data.vocabs || [];
  if (leftCards.length !== originalCards.length || rightCards.length !== originalCards.length) {
    throw new Error(`Phrase card count mismatch for ${sourceItem.id}`);
  }
  return originalCards.some((card, index) => {
    const leftCard = leftCards[index];
    const rightCard = rightCards[index];
    if (leftCard?.id !== card.id || rightCard?.id !== card.id) {
      throw new Error(`Phrase card identity mismatch for ${sourceItem.id}/${index}`);
    }
    return isExcluded(leftCard.usageAudit) !== isExcluded(rightCard.usageAudit) ||
      examplesDisagree(card.examples, leftCard.examples, rightCard.examples);
  });
}

const items = source.items.filter(item => needsAdjudication(
  item,
  firstById.get(item.id),
  secondById.get(item.id),
));
writeFileSync(resolve(outputArg), `${JSON.stringify({
  version: 1,
  exportedAt: source.exportedAt,
  items,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Prepared third-pass adjudication for ${items.length}/${source.items.length} item(s)\n`);
