import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectIncompleteSavedSentences } from '../incremental-saved-sentences.js';

const [corpusArg, outputArg, previousArg, baseAnalysisOutputArg] = process.argv.slice(2);
if (!corpusArg || !outputArg) {
  throw new Error(
    'Usage: prepare-incremental-saved-sentence-source <corpus-export.json> <output.json> [previous-source.json|-] [base-analysis.json]',
  );
}

const readJson = (path: string): any => JSON.parse(readFileSync(resolve(path), 'utf8'));
const corpus = readJson(corpusArg);
const previous = previousArg && previousArg !== '-' && existsSync(resolve(previousArg))
  ? readJson(previousArg)
  : undefined;
const source = collectIncompleteSavedSentences(corpus, previous);
const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
if (baseAnalysisOutputArg) {
  const sourceById = new Map(source.sentences.map(sentence => [sentence.id, sentence]));
  const entries = corpus.items.flatMap((item: any) => {
    const sentence = sourceById.get(item?.data?.id);
    const analysis = item?.data?.analysis;
    if (!sentence || !analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return [];
    return [{
      id: sentence.id,
      textHash: sentence.textHash,
      analysis,
      generatedAt: Number(item.data.analysisGeneratedAt || corpus.exportedAt || Date.now()),
    }];
  });
  const baseAnalysisPath = resolve(baseAnalysisOutputArg);
  mkdirSync(dirname(baseAnalysisPath), { recursive: true });
  writeFileSync(baseAnalysisPath, `${JSON.stringify({
    version: 1,
    generatedAt: Number(corpus.exportedAt || Date.now()),
    entries,
  }, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(source.stats, null, 2)}\n`);
