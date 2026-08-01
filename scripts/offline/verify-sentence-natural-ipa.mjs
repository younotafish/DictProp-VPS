#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [corpusArg, ipaArg, reportArg] = process.argv.slice(2);
if (!corpusArg || !ipaArg) {
  throw new Error('Usage: verify-sentence-natural-ipa.mjs <corpus-or-sentence-export.json> <ipa-manifest.json> [report.json]');
}

const corpus = JSON.parse(readFileSync(resolve(corpusArg), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(ipaArg), 'utf8'));
if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
  throw new Error('IPA manifest is invalid');
}

const stripMarkers = text => String(text || '').replace(/\{\{|\}\}|\[\[|\]\]/g, '');
let sentenceSources;
if (Array.isArray(corpus?.items)) {
  sentenceSources = corpus.items.filter(item => item?.type === 'sentence' && !item.isDeleted).map(item => item.data);
} else if (corpus?.version === 1 && Array.isArray(corpus.sentences)) {
  sentenceSources = corpus.sentences;
} else {
  throw new Error('Sentence source is invalid');
}
const sourceById = new Map(sentenceSources.map(source => [source?.id, source]));
if (sourceById.size !== sentenceSources.length || sourceById.has(undefined)) {
  throw new Error('Sentence source contains invalid or duplicate ids');
}
const issues = [];
const warnings = [];
const seen = new Set();
const ipaToSources = new Map();
let ipaBytes = 0;
let ipaCharacters = 0;

if (typeof manifest.model !== 'string' ||
    (manifest.model !== 'gpt-5.6-sol' && !manifest.model.startsWith('cross-reviewed:'))) {
  issues.push(`unexpected model: ${manifest.model || 'missing'}`);
}
if (manifest.entries.length !== sentenceSources.length) {
  issues.push(`entry count ${manifest.entries.length} does not match sentence count ${sentenceSources.length}`);
}

for (const entry of manifest.entries) {
  const id = entry?.id;
  if (typeof id !== 'string' || !id) {
    issues.push('entry has an invalid id');
    continue;
  }
  if (seen.has(id)) {
    issues.push(`${id}: duplicate id`);
    continue;
  }
  seen.add(id);
  const source = sourceById.get(id);
  if (!source) {
    issues.push(`${id}: not found in source corpus`);
    continue;
  }
  const expectedHash = createHash('sha256').update(source.text || '').digest('hex');
  if (entry.textHash !== expectedHash) issues.push(`${id}: stale text hash`);
  const ipa = typeof entry.naturalSpeechIpa === 'string' ? entry.naturalSpeechIpa.trim() : '';
  if (!/^\/[^/\n]+\/$/.test(ipa)) issues.push(`${id}: IPA must have exactly one surrounding slash pair`);
  if (/[\[\]{}<>`]/.test(ipa)) issues.push(`${id}: IPA contains markup`);
  if (/[0-9A-Z]/.test(ipa)) issues.push(`${id}: IPA contains digits or uppercase spelling`);
  if (/əʊ|ɜː|ɒ/.test(ipa)) issues.push(`${id}: IPA contains a likely non-American transcription symbol sequence`);
  const sourceWords = stripMarkers(source.text).match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  const ipaTokens = ipa.slice(1, -1).trim().split(/\s+/).filter(Boolean);
  if (sourceWords.length >= 6 && ipaTokens.length < Math.ceil(sourceWords.length * 0.55)) {
    issues.push(`${id}: transcription appears incomplete (${ipaTokens.length} IPA tokens for ${sourceWords.length} written words)`);
  }
  if (ipaTokens.length > sourceWords.length * 1.7 + 4) {
    issues.push(`${id}: transcription has implausibly many tokens (${ipaTokens.length} IPA tokens for ${sourceWords.length} written words)`);
  }
  ipaBytes += Buffer.byteLength(ipa);
  ipaCharacters += [...ipa].length;
  const plainSource = stripMarkers(source.text).replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  const duplicateSources = ipaToSources.get(ipa) || new Set();
  duplicateSources.add(plainSource);
  ipaToSources.set(ipa, duplicateSources);
}

for (const id of sourceById.keys()) {
  if (!seen.has(id)) issues.push(`${id}: missing IPA entry`);
}
for (const [ipa, sources] of ipaToSources) {
  if (sources.size > 1) warnings.push(`same IPA is used for ${sources.size} different source sentences: ${ipa}`);
}

const report = {
  version: 1,
  verifiedAt: Date.now(),
  model: manifest.model,
  sourceSentences: sentenceSources.length,
  ipaEntries: manifest.entries.length,
  ipaBytes,
  averageIpaBytes: manifest.entries.length ? Math.round(ipaBytes / manifest.entries.length) : 0,
  averageIpaCharacters: manifest.entries.length ? Math.round(ipaCharacters / manifest.entries.length) : 0,
  issueCount: issues.length,
  warningCount: warnings.length,
  issues,
  warnings,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (reportArg) writeFileSync(resolve(reportArg), output, { mode: 0o600 });
process.stdout.write(output);
if (issues.length > 0) process.exitCode = 1;
