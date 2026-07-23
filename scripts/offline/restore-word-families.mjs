#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [currentArg, trustedArg, outputArg] = process.argv.slice(2);
if (!currentArg || !trustedArg || !outputArg) {
  throw new Error('Usage: restore-word-families.mjs <current-corpus-export.json> <trusted-corpus-export.json> <output-manifest.json>');
}

const readJson = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const current = readJson(currentArg);
const trusted = readJson(trustedArg);
if (!Array.isArray(current?.items) || !Array.isArray(trusted?.items)) {
  throw new Error('Current and trusted corpus exports must contain items arrays');
}

const normalizeWord = value => String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const clone = value => structuredClone(value);
const trustedCards = new Map();
const trustedItemIds = new Set();
for (const item of trusted.items) {
  if (typeof item?.id !== 'string' || trustedItemIds.has(item.id)) {
    throw new Error(`Trusted corpus has an invalid or duplicate item id: ${String(item?.id)}`);
  }
  trustedItemIds.add(item.id);
  const cards = item.type === 'vocab'
    ? [item.data]
    : item.type === 'phrase' && Array.isArray(item.data?.vocabs) ? item.data.vocabs : [];
  const cardIds = new Set();
  for (const card of cards) {
    if (typeof card?.id !== 'string' || cardIds.has(card.id)) {
      throw new Error(`Trusted item ${item.id} has an invalid or duplicate card id: ${String(card?.id)}`);
    }
    cardIds.add(card.id);
    trustedCards.set(`${item.id}\0${card.id}`, card);
  }
}

const shouldArchive = audit => audit?.confidence !== 'low' &&
  ['narrow_specialized', 'british_only', 'rare_or_dated'].includes(audit?.status);
const withoutImages = value => {
  if (Array.isArray(value)) return value.map(withoutImages);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'imageUrl')
    .map(([key, child]) => [key, withoutImages(child)]));
};
const sourceHash = data => {
  const stable = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'analysis' && key !== 'analysisGeneratedAt'))
    : data;
  return createHash('sha256').update(JSON.stringify(withoutImages(stable))).digest('hex');
};

let restoredCards = 0;
let restoredMembers = 0;
let skippedChangedWords = 0;
const entries = [];
const itemIds = new Set();
for (const item of current.items) {
  if (typeof item?.id !== 'string' || itemIds.has(item.id)) {
    throw new Error(`Current corpus has an invalid or duplicate item id: ${String(item?.id)}`);
  }
  itemIds.add(item.id);
  if (item.sourceHash !== sourceHash(item.data)) {
    throw new Error(`Current corpus source hash does not match data: ${item.id}`);
  }

  let changed = false;
  const restoreCard = card => {
    const trustedCard = trustedCards.get(`${item.id}\0${card?.id}`);
    if (!trustedCard || !Array.isArray(trustedCard.wordFamily) || trustedCard.wordFamily.length === 0 ||
        (Array.isArray(card.wordFamily) && card.wordFamily.length > 0)) {
      return card;
    }
    if (normalizeWord(card.word) !== normalizeWord(trustedCard.word)) {
      skippedChangedWords++;
      return card;
    }
    changed = true;
    restoredCards++;
    restoredMembers += trustedCard.wordFamily.length;
    return { ...card, wordFamily: clone(trustedCard.wordFamily) };
  };

  let data = item.data;
  if (item.type === 'vocab') {
    data = restoreCard(item.data);
  } else if (item.type === 'phrase' && Array.isArray(item.data?.vocabs)) {
    const vocabs = item.data.vocabs.map(restoreCard);
    if (changed) data = { ...item.data, vocabs };
  }
  if (!changed) continue;
  entries.push({
    id: item.id,
    type: item.type,
    sourceHash: item.sourceHash,
    data,
    wasArchived: item.wasArchived === true,
    archiveForUsage: shouldArchive(data.usageAudit),
  });
}

if (entries.length === 0) throw new Error('No empty word families could be restored');
const output = {
  version: 1,
  generatedAt: Date.now(),
  model: `deterministic restoration from verified corpus export ${trusted.exportedAt || 'unknown'}`,
  entries,
};
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  currentItems: current.items.length,
  trustedItems: trusted.items.length,
  repairedItems: entries.length,
  restoredCards,
  restoredMembers,
  skippedChangedWords,
}, null, 2)}\n`);
