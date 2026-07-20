#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [analysisArg, overridesArg, outputArg] = process.argv.slice(2);
if (!analysisArg || !overridesArg || !outputArg) {
  throw new Error('Usage: apply-sentence-analysis-overrides.mjs <analysis.json> <overrides.json> <output.json>');
}

const analysis = readJson(analysisArg);
const overrides = readJson(overridesArg);
if (!Array.isArray(analysis?.entries) || !Array.isArray(overrides?.entries)) {
  throw new Error('Analysis or override manifest is invalid');
}
const byId = new Map(analysis.entries.map(entry => [entry.id, entry]));
if (byId.size !== analysis.entries.length) throw new Error('Analysis manifest contains duplicate ids');
const seen = new Set();
for (const override of overrides.entries) {
  if (seen.has(override.id)) throw new Error(`Override manifest contains duplicate id: ${override.id}`);
  seen.add(override.id);
  const entry = byId.get(override.id);
  if (!entry || entry.textHash !== override.textHash) throw new Error(`Override identity mismatch: ${override.id}`);
  if (!['american', 'shared', 'not_american'].includes(override.americanEnglish?.status) ||
      typeof override.americanEnglish?.explanation !== 'string' || !override.americanEnglish.explanation.trim()) {
    throw new Error(`Invalid American-English override: ${override.id}`);
  }
  entry.analysis.americanEnglish = structuredClone(override.americanEnglish);
  entry.generatedAt = Math.max(Number(entry.generatedAt || 0), Number(overrides.generatedAt || 0));
}

const output = {
  ...analysis,
  generatedAt: Math.max(Number(analysis.generatedAt || 0), Number(overrides.generatedAt || 0)),
};
const outputPath = resolve(outputArg);
const temporaryPath = `${outputPath}.tmp-${process.pid}`;
writeFileSync(temporaryPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
renameSync(temporaryPath, outputPath);
process.stdout.write(`${JSON.stringify({ analyses: analysis.entries.length, overridesApplied: seen.size })}\n`);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}
