import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { corpusSourceHash, validateCorpusAuditBundle } from '../src/corpus-audit.js';

const audit = {
  status: 'current_general',
  reason: 'This remains useful current general English.',
  confidence: 'high',
  auditedAt: 1,
};

const card = (id: string, word: string, wordFamily: any[]) => ({
  id,
  word,
  sense: 'verb: test sense',
  chinese: '测试',
  ipa: '/test/',
  definition: 'A complete test definition.',
  forms: [],
  wordFamily,
  synonyms: ['check'],
  antonyms: [],
  confusables: [],
  examples: ['I {{test}} this carefully.'],
  history: 'A sufficiently complete historical note.',
  register: 'Current general English.',
  mnemonic: 'A sufficiently useful memory aid.',
  imagePrompt: 'A realistic test scene with no visible text anywhere.',
  usageAudit: audit,
});

const scriptPath = (name: string) => fileURLToPath(new URL(`../../scripts/offline/${name}`, import.meta.url));

test('word-family restoration changes only empty, identity-matched families', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-family-'));
  try {
    const currentPath = join(root, 'current.json');
    const trustedPath = join(root, 'trusted.json');
    const outputPath = join(root, 'manifest.json');
    const currentCards = [
      card('restore', 'incur', []),
      card('keep', 'stable', [{ word: 'stability', pos: 'noun', chinese: '稳定性' }]),
      card('renamed', 'new spelling', []),
    ];
    const trustedCards = [
      card('restore', 'incur', [{ word: 'incursion', pos: 'noun', chinese: '招致' }]),
      card('keep', 'stable', [{ word: 'unstable', pos: 'adjective', chinese: '不稳定的' }]),
      card('renamed', 'old spelling', [{ word: 'older', pos: 'adjective', chinese: '旧的' }]),
    ];
    const makeVocabItems = (cards: any[]) => cards.map(data => ({
      id: data.id,
      type: 'vocab',
      sourceHash: corpusSourceHash(data),
      wasArchived: false,
      data,
    }));
    const currentPhrase = {
      id: 'phrase',
      query: 'shared phrase',
      usageAudit: audit,
      vocabs: [card('restore', 'nested use', [])],
    };
    const trustedPhrase = {
      ...currentPhrase,
      vocabs: [card('restore', 'nested use', [{ word: 'nested usage', pos: 'noun', chinese: '嵌套用法' }])],
    };
    const phraseItem = (data: any) => ({
      id: data.id,
      type: 'phrase',
      sourceHash: corpusSourceHash(data),
      wasArchived: false,
      data,
    });
    writeFileSync(currentPath, JSON.stringify({
      version: 1,
      exportedAt: 2,
      items: [...makeVocabItems(currentCards), phraseItem(currentPhrase)],
    }));
    writeFileSync(trustedPath, JSON.stringify({
      version: 1,
      exportedAt: 1,
      items: [...makeVocabItems(trustedCards), phraseItem(trustedPhrase)],
    }));

    execFileSync(process.execPath, [
      scriptPath('restore-word-families.mjs'),
      currentPath,
      trustedPath,
      outputPath,
    ]);

    const manifest = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(validateCorpusAuditBundle(manifest), null);
    assert.equal(manifest.entries.length, 2);
    assert.equal(manifest.entries[0].id, 'restore');
    assert.deepEqual(manifest.entries[0].data.wordFamily, trustedCards[0].wordFamily);
    assert.equal(manifest.entries[0].data.definition, currentCards[0].definition);
    assert.equal(manifest.entries[0].sourceHash, corpusSourceHash(currentCards[0]));
    assert.equal(manifest.entries[1].id, 'phrase');
    assert.deepEqual(manifest.entries[1].data.vocabs[0].wordFamily, trustedPhrase.vocabs[0].wordFamily);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('metadata reconciliation preserves an existing verified word family', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-family-reconcile-'));
  try {
    const reviewedPath = join(root, 'reviewed.json');
    const latestPath = join(root, 'latest.json');
    const deltaPath = join(root, 'delta.json');
    const outputPath = join(root, 'output.json');
    const current = card('incur', 'incur', [{ word: 'incursion', pos: 'noun', chinese: '招致' }]);
    const regenerated = card('incur', 'incur', []);
    const hash = corpusSourceHash(current);
    writeFileSync(reviewedPath, JSON.stringify({
      version: 1,
      model: 'test model',
      entries: [{
        id: 'incur',
        type: 'vocab',
        sourceHash: hash,
        data: regenerated,
        wasArchived: false,
        archiveForUsage: false,
      }],
    }));
    writeFileSync(latestPath, JSON.stringify({
      version: 1,
      exportedAt: 2,
      items: [{ id: 'incur', type: 'vocab', sourceHash: hash, wasArchived: false, data: current }],
    }));

    execFileSync(process.execPath, [
      scriptPath('reconcile-regenerated-metadata.mjs'),
      reviewedPath,
      latestPath,
      deltaPath,
      outputPath,
    ]);

    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(output.entries[0].data.wordFamily, current.wordFamily);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
