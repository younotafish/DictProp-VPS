#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [sourceArg, workArg, outputArg, analysisManifestArg] = process.argv.slice(2);
if (!sourceArg || !workArg || !outputArg) {
  throw new Error('Usage: audit-sentence-analysis-cache.mjs <sentence-export.json> <work-directory> <report.json> [analysis-manifest.json]');
}

const sourcePath = resolve(sourceArg);
const workDir = resolve(workArg);
const outputPath = resolve(outputArg);
const analysisManifestPath = analysisManifestArg ? resolve(analysisManifestArg) : null;
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
if (source?.version !== 1 || !Array.isArray(source.sentences)) throw new Error('Sentence export is invalid');

const normalizedValue = value => String(value || '')
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');
const plainSentence = value => String(value || '')
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^\[\]]+)\]\]/g, '$1');
const validTermIpa = value => {
  const ipa = String(value || '').trim();
  const transcriptions = ipa.match(/\/[^/\n]+\//g) || [];
  if (transcriptions.length === 0) return false;
  const annotations = ipa.replace(/\/[^/\n]+\//g, '');
  return !annotations.includes('/') &&
    /^(?:[\s;,:()[\]\-–—]*(?:past|present|plural|singular|also|or|american|us|noun|verb|adjective|adverb|stressed|unstressed)?)*[\s;,:()[\]\-–—]*$/i.test(annotations);
};
const leakedPlaceholder = value => /^(?:placeholder|tbd|todo|(?:natural\s*speech\s*ipa|original\s*meaning|historical\s*evolution|image\s*prompt)(?:\s+placeholder)?)[.!]?$/i
  .test(String(value || '').trim());
const batchSize = 12;
const activeUsageStatuses = new Set(['modern_american', 'current_general', 'narrow_specialized']);
const files = readdirSync(workDir);
const issues = [];
const notAmerican = [];
const statusCounts = {};
let cachedBatches = 0;
let cachedAnalyses = 0;

function addIssue(type, batchNumber, file, sourceRecord, detail) {
  issues.push({ type, batchNumber, file, id: sourceRecord?.id || null, text: sourceRecord?.text || null, detail });
}

function auditAnalysis(sourceRecord, analysis, batchNumber, file) {
  if (!analysis || typeof analysis !== 'object') {
    addIssue('invalid_analysis', batchNumber, file, sourceRecord, 'analysis is missing');
    return;
  }
  if (!/^\/[^/]+\/$/.test(String(analysis.naturalSpeechIpa || '').trim())) {
    addIssue('invalid_sentence_ipa', batchNumber, file, sourceRecord, analysis.naturalSpeechIpa);
  }
  for (const [field, value] of [
    ['translation', analysis.translation],
    ['naturalSpeechIpa', analysis.naturalSpeechIpa],
    ['americanEnglish.explanation', analysis.americanEnglish?.explanation],
    ['imagePrompt', analysis.imagePrompt],
  ]) {
    if (leakedPlaceholder(value)) addIssue('placeholder_leak', batchNumber, file, sourceRecord, { field, value });
  }
  const terms = Array.isArray(analysis.terms) ? analysis.terms : [];
  const seenTerms = new Set();
  for (let termIndex = 0; termIndex < terms.length; termIndex++) {
    const term = terms[termIndex];
    const termKey = normalizedValue(term?.term);
    if (seenTerms.has(termKey)) addIssue('duplicate_term', batchNumber, file, sourceRecord, term?.term);
    seenTerms.add(termKey);
    if (!validTermIpa(term?.ipa)) {
      addIssue('invalid_term_ipa', batchNumber, file, sourceRecord, { term: term?.term, ipa: term?.ipa });
    }
    const fields = [
      ['term', term?.term], ['chinese', term?.chinese], ['ipa', term?.ipa],
      ['originalMeaning', term?.originalMeaning], ['historicalEvolution', term?.historicalEvolution],
      ...((term?.synonyms || []).map((value, index) => [`synonyms[${index}]`, value])),
      ...((term?.antonyms || []).map((value, index) => [`antonyms[${index}]`, value])),
      ...((term?.examples || []).map((value, index) => [`examples[${index}]`, value])),
    ];
    for (const [field, value] of fields) {
      if (leakedPlaceholder(value)) addIssue('placeholder_leak', batchNumber, file, sourceRecord, { term: term?.term, field, value });
    }
    const exampleKeys = (term?.examples || []).map(normalizedValue);
    if (new Set(exampleKeys).size !== exampleKeys.length) {
      addIssue('duplicate_term_example', batchNumber, file, sourceRecord, term?.term);
    }
    const sourceKey = normalizedValue(plainSentence(sourceRecord.text));
    if (exampleKeys.includes(sourceKey)) addIssue('source_reused_as_example', batchNumber, file, sourceRecord, term?.term);
  }
  if (analysis.americanEnglish?.status === 'not_american') {
    const statuses = [...new Set((sourceRecord.provenance || []).map(entry => entry.usageStatus || 'unknown'))];
    for (const status of statuses) statusCounts[status] = (statusCounts[status] || 0) + 1;
    notAmerican.push({
      id: sourceRecord.id,
      text: sourceRecord.text,
      sourceWord: sourceRecord.sourceWord,
      sourceSense: sourceRecord.sourceSense,
      usageStatuses: statuses,
      explanation: analysis.americanEnglish.explanation,
      provenance: sourceRecord.provenance || [],
    });
  }
}

for (let offset = 0; offset < source.sentences.length; offset += batchSize) {
  const batch = source.sentences.slice(offset, offset + batchSize);
  const compact = batch.map(({ text, sourceWord, sourceSense }, itemIndex) => ({ itemIndex, text, sourceWord, sourceSense }));
  const fingerprint = createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0, 16);
  const batchNumber = Math.floor(offset / batchSize) + 1;
  const file = `batch-${String(batchNumber).padStart(4, '0')}-${fingerprint}.json`;
  if (!files.includes(file)) continue;
  cachedBatches++;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(workDir, file), 'utf8'));
  } catch (error) {
    addIssue('invalid_json', batchNumber, file, null, error instanceof Error ? error.message : String(error));
    continue;
  }
  if (!Array.isArray(parsed.results)) {
    addIssue('invalid_result_shape', batchNumber, file, null, 'results is not an array');
    continue;
  }
  const indexes = new Set();
  for (const result of parsed.results) {
    const itemIndex = result?.itemIndex;
    const sourceRecord = Number.isInteger(itemIndex) ? batch[itemIndex] : null;
    if (!sourceRecord || indexes.has(itemIndex)) {
      addIssue('invalid_item_index', batchNumber, file, sourceRecord, String(itemIndex));
      continue;
    }
    indexes.add(itemIndex);
    cachedAnalyses++;
    if (!analysisManifestPath) auditAnalysis(sourceRecord, result.analysis, batchNumber, file);
  }
  if (indexes.size !== batch.length) {
    addIssue('wrong_result_count', batchNumber, file, null, { expected: batch.length, actual: indexes.size });
  }
}

let auditedAnalyses = cachedAnalyses;
if (analysisManifestPath) {
  const manifest = JSON.parse(readFileSync(analysisManifestPath, 'utf8'));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('Sentence analysis manifest is invalid');
  }
  const sourceById = new Map(source.sentences.map(entry => [entry.id, entry]));
  if (sourceById.size !== source.sentences.length) throw new Error('Sentence export contains duplicate ids');
  const analysisById = new Map();
  for (const entry of manifest.entries) {
    if (typeof entry?.id !== 'string' || !entry.id || analysisById.has(entry.id)) {
      addIssue('invalid_or_duplicate_analysis_id', null, analysisManifestPath, sourceById.get(entry?.id), entry?.id);
      continue;
    }
    analysisById.set(entry.id, entry);
  }
  auditedAnalyses = 0;
  for (const sourceRecord of source.sentences) {
    const entry = analysisById.get(sourceRecord.id);
    if (!entry) {
      addIssue('missing_manifest_analysis', null, analysisManifestPath, sourceRecord, null);
      continue;
    }
    if (entry.textHash !== sourceRecord.textHash) {
      addIssue('analysis_text_hash_mismatch', null, analysisManifestPath, sourceRecord, {
        expected: sourceRecord.textHash,
        actual: entry.textHash,
      });
      continue;
    }
    auditedAnalyses++;
    auditAnalysis(sourceRecord, entry.analysis, null, analysisManifestPath);
  }
  for (const entry of manifest.entries) {
    if (!sourceById.has(entry?.id)) addIssue('analysis_outside_source', null, analysisManifestPath, null, entry?.id);
  }
}

const report = {
  version: 1,
  generatedAt: Date.now(),
  sourcePath,
  workDir,
  analysisManifestPath,
  stats: {
    sourceSentences: source.sentences.length,
    expectedBatches: Math.ceil(source.sentences.length / batchSize),
    cachedBatches,
    cachedAnalyses,
    auditedAnalyses,
    issues: issues.length,
    notAmerican: notAmerican.length,
    notAmericanActive: notAmerican.filter(entry =>
      entry.usageStatuses.some(status => activeUsageStatuses.has(status))).length,
    notAmericanByUsageStatus: Object.fromEntries(Object.entries(statusCounts).sort(([left], [right]) => left.localeCompare(right))),
  },
  issues,
  notAmerican,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report.stats, null, 2)}\n`);
if (issues.length > 0) process.exitCode = 2;
