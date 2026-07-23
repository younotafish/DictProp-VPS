#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [reviewedArg, latestArg, deltaArg, outputArg, deltaReviewedArg] = process.argv.slice(2);
if (!reviewedArg || !latestArg || !deltaArg || !outputArg) {
  throw new Error('Usage: reconcile-regenerated-metadata.mjs <reviewed-manifest> <latest-corpus-export> <delta-input.json> <output-manifest.json> [delta-reviewed-manifest]');
}

const readJson = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const reviewed = readJson(reviewedArg);
const latest = readJson(latestArg);
const deltaReviewed = deltaReviewedArg ? readJson(deltaReviewedArg) : null;
if (!Array.isArray(reviewed?.entries) || !Array.isArray(latest?.items) ||
    (deltaReviewed && !Array.isArray(deltaReviewed.entries))) {
  throw new Error('Reviewed manifest, latest export, or delta review is invalid');
}

const clone = value => structuredClone(value);
const reviewedById = new Map(reviewed.entries.map(entry => [entry.id, entry]));
const deltaReviewedById = new Map((deltaReviewed?.entries || []).map(entry => [entry.id, entry]));

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

function shouldArchive(audit) {
  return audit?.confidence !== 'low' &&
    ['narrow_specialized', 'british_only', 'rare_or_dated'].includes(audit?.status);
}

function copyImageMarker(target, current) {
  if (Object.hasOwn(current || {}, 'imageUrl')) target.imageUrl = current.imageUrl;
  else delete target.imageUrl;
}

const changedLexical = latest.items.filter(item => {
  if (!['vocab', 'phrase'].includes(item.type)) return false;
  const completed = reviewedById.get(item.id);
  return !completed || completed.sourceHash !== item.sourceHash;
});
const deltaRecords = [
  ...changedLexical,
  ...latest.items.filter(item => item.type === 'sentence'),
];
const delta = {
  version: 1,
  exportedAt: latest.exportedAt,
  items: deltaRecords,
};
mkdirSync(dirname(resolve(deltaArg)), { recursive: true });
writeFileSync(resolve(deltaArg), `${JSON.stringify(delta, null, 2)}\n`, { mode: 0o600 });

const unresolved = changedLexical.filter(item => {
  const completed = deltaReviewedById.get(item.id);
  return !completed || completed.sourceHash !== item.sourceHash;
});
if (unresolved.length > 0) {
  process.stderr.write(`Prepared delta with ${changedLexical.length} changed/new lexical item(s) and ${deltaRecords.length - changedLexical.length} sentence context record(s)\n`);
  process.stderr.write(`Regenerate and review the delta, then rerun with its reviewed manifest: ${unresolved.slice(0, 20).map(item => item.id).join(', ')}\n`);
  process.exitCode = 2;
} else {
  const selectedEntry = item => {
    const primary = reviewedById.get(item.id);
    if (primary?.sourceHash === item.sourceHash) return primary;
    const incremental = deltaReviewedById.get(item.id);
    if (incremental?.sourceHash === item.sourceHash) return incremental;
    throw new Error(`No regenerated metadata matches latest source ${item.id}`);
  };

  const savedSentences = latest.items.filter(item => item.type === 'sentence').map(item => item.data);
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

  function mergeCard(targetCard, latestCard) {
    const target = clone(targetCard);
    copyImageMarker(target, latestCard);
    // A model may legitimately find no family for a new opaque phrase, but an empty response must not
    // erase a previously verified family from an existing card during corpus reconciliation.
    if ((!Array.isArray(target.wordFamily) || target.wordFamily.length === 0) &&
        Array.isArray(latestCard.wordFamily) && latestCard.wordFamily.length > 0) {
      target.wordFamily = clone(latestCard.wordFamily);
    }
    const protectedExamples = protectedExamplesFor(latestCard);
    if (protectedExamples.length > 0) {
      target.examples = clone(Array.isArray(latestCard.examples) ? latestCard.examples : []);
      return target;
    }
    const seen = new Set();
    target.examples = (target.examples || []).filter(example => {
      const key = normalizedSentence(example);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return target;
  }

  const senseChanges = new Map();
  const lexicalData = new Map();
  for (const item of latest.items) {
    if (item.type === 'vocab') {
      const target = mergeCard(selectedEntry(item).data, item.data);
      lexicalData.set(item.id, target);
      const key = lexicalKey(item.data.word, item.data.sense);
      if (!senseChanges.has(key)) senseChanges.set(key, new Set());
      senseChanges.get(key).add(target.sense);
    } else if (item.type === 'phrase') {
      const selected = clone(selectedEntry(item).data);
      copyImageMarker(selected, item.data);
      const latestCards = new Map((item.data.vocabs || []).map(card => [card.id, card]));
      selected.vocabs = (selected.vocabs || []).map(card => {
        const current = latestCards.get(card.id);
        if (!current) throw new Error(`Phrase card disappeared during reconciliation: ${item.id}/${card.id}`);
        return mergeCard(card, current);
      });
      lexicalData.set(item.id, selected);
    }
  }

  let sentenceSenseLinksUpdated = 0;
  let protectedExamplesRestored = 0;
  let lockedExampleListsRestored = 0;
  const entries = latest.items.map(item => {
    let data;
    if (item.type === 'sentence') {
      data = clone(item.data);
      if (data.sourceSense) {
        const changes = senseChanges.get(lexicalKey(data.sourceWord, data.sourceSense));
        if (changes?.size === 1) {
          const nextSense = [...changes][0];
          if (nextSense !== data.sourceSense) {
            data.sourceSense = nextSense;
            sentenceSenseLinksUpdated++;
          }
        }
      }
    } else {
      data = lexicalData.get(item.id);
      if (!data) throw new Error(`Missing reconciled lexical data: ${item.id}`);
      if (item.type === 'vocab') {
        const protectedExamples = protectedExamplesFor(item.data);
        protectedExamplesRestored += protectedExamples.filter(example => data.examples.includes(example)).length;
        if (protectedExamples.length > 0) lockedExampleListsRestored++;
      } else {
        const latestCards = new Map((item.data.vocabs || []).map(card => [card.id, card]));
        for (const card of data.vocabs || []) {
          const current = latestCards.get(card.id);
          if (current) {
            const protectedExamples = protectedExamplesFor(current);
            protectedExamplesRestored += protectedExamples.filter(example => card.examples.includes(example)).length;
            if (protectedExamples.length > 0) lockedExampleListsRestored++;
          }
        }
      }
    }
    return {
      id: item.id,
      type: item.type,
      sourceHash: item.sourceHash,
      data,
      wasArchived: item.wasArchived === true,
      archiveForUsage: shouldArchive(data.usageAudit),
    };
  });

  const generatedAt = Date.now();
  const output = {
    version: 1,
    generatedAt,
    model: `${reviewed.model}; reconciled against production export ${latest.exportedAt}`,
    entries,
  };
  mkdirSync(dirname(resolve(outputArg)), { recursive: true });
  writeFileSync(resolve(outputArg), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    generatedAt,
    latestRecords: latest.items.length,
    changedLexicalItems: changedLexical.length,
    deltaContextRecords: deltaRecords.length,
    sentenceSenseLinksUpdated,
    protectedExamplesRestored,
    lockedExampleListsRestored,
  }, null, 2)}\n`);
}
