// Run by the Mac's enrichment cycle (scripts/offline/run-incremental-example-enrichment.sh) under tsx, never on the
// VPS: it turns a corpus export into the saved sentences still to analyse, and their partial analyses to build on.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectIncompleteSavedSentences } from '../incremental-saved-sentences.js';
import { fieldsOf } from '../local-enrichment-markers.js';

const [corpusArg, outputArg, previousArg, baseAnalysisOutputArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-saved-sentence-source <corpus-export.json> <output.json> [previous-source.json|-] [base-analysis.json]',
  );
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(path), 'utf8'));
const corpus = readJson(corpusArg);
const previous = previousArg && previousArg !== '-' && existsSync(resolve(previousArg))
  ? readJson(previousArg)
  : undefined;
const source = collectIncompleteSavedSentences(corpus, previous);
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
if (baseAnalysisOutputArg) {
  const { items, exportedAt } = fieldsOf(corpus);
  // collectIncompleteSavedSentences has refused a corpus without an items list.
  const records: readonly unknown[] = Array.isArray(items) ? items : [];
  const sourceById = new Map(source.sentences.map(sentence => [sentence.id, sentence]));
  const entries = records.flatMap(item => {
    const data = fieldsOf(fieldsOf(item).data);
    const sentence = typeof data.id === 'string' ? sourceById.get(data.id) : undefined;
    const { analysis } = data;
    if (!sentence || !analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return [];
    return [{
      id: sentence.id,
      textHash: sentence.textHash,
      analysis,
      generatedAt: Number(data.analysisGeneratedAt || exportedAt || Date.now()),
    }];
  });
  const baseAnalysisPath = resolve(baseAnalysisOutputArg);
  mkdirSync(dirname(baseAnalysisPath), { recursive: true });
  writeFileSync(baseAnalysisPath, `${JSON.stringify({
    version: 1,
    generatedAt: Number(exportedAt || Date.now()),
    entries,
  }, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(source.stats, null, 2)}\n`);
