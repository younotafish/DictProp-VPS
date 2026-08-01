#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [analysisArg, ipaArg, outputArg] = process.argv.slice(2);
if (!analysisArg || !ipaArg || !outputArg) {
  throw new Error('Usage: apply-reviewed-natural-ipa.mjs <analysis.json> <ipa.json> <output.json>');
}

const analysis = JSON.parse(readFileSync(resolve(analysisArg), 'utf8'));
const ipa = JSON.parse(readFileSync(resolve(ipaArg), 'utf8'));
if (analysis?.version !== 1 || !Array.isArray(analysis.entries) ||
    ipa?.version !== 1 || !Array.isArray(ipa.entries)) {
  throw new Error('Analysis or IPA manifest is invalid');
}

const ipaById = new Map(ipa.entries.map(entry => [entry.id, entry]));
if (ipaById.size !== ipa.entries.length || ipa.entries.length !== analysis.entries.length) {
  throw new Error('Analysis and IPA manifests must contain the same unique sentence identities');
}

const entries = analysis.entries.map(entry => {
  const reviewed = ipaById.get(entry.id);
  if (!reviewed || reviewed.textHash !== entry.textHash || !/^\/[^/\n]+\/$/.test(reviewed.naturalSpeechIpa || '')) {
    throw new Error(`Missing, invalid, or stale reviewed IPA: ${entry.id}`);
  }
  const pronunciation = entry.analysis?.pronunciation;
  if (!pronunciation || typeof pronunciation.slowIpa !== 'string') {
    throw new Error(`Detailed pronunciation is missing: ${entry.id}`);
  }
  return {
    ...entry,
    generatedAt: Math.max(Number(entry.generatedAt || 0), Number(reviewed.generatedAt || 0)),
    analysis: {
      ...entry.analysis,
      pronunciation: { ...pronunciation, fastIpa: reviewed.naturalSpeechIpa },
      naturalSpeechIpa: reviewed.naturalSpeechIpa,
    },
  };
});

writeFileSync(resolve(outputArg), `${JSON.stringify({
  ...analysis,
  generatedAt: Math.max(Number(analysis.generatedAt || 0), Number(ipa.generatedAt || 0)),
  entries,
}, null, 2)}\n`, { mode: 0o600 });
process.stderr.write(`Applied ${entries.length} cross-reviewed connected-speech IPA records\n`);

