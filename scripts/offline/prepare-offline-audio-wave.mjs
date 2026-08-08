import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const [sourceArg, outputArg, limitArg, ...publishedPaths] = process.argv.slice(2);
if (!sourceArg || !outputArg || !limitArg) {
  throw new Error('Usage: prepare-offline-audio-wave <source-root> <output-root> <limit> [published-manifest ...]');
}
const sourceRoot = resolve(sourceArg);
const outputRoot = resolve(outputArg);
const limit = Number(limitArg);
if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) throw new Error('limit must be between 1 and 2000');

const source = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8'));
if (source?.version !== 1 || !Array.isArray(source.entries)) throw new Error('source audio manifest is invalid');
const published = new Set();
for (const path of publishedPaths) {
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'));
  for (const entry of manifest.entries ?? []) published.add(entry.key);
}

const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const inside = (root, relative) => {
  const path = resolve(root, relative);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`unsafe audio path: ${relative}`);
  return path;
};

const selected = [];
for (const entry of source.entries) {
  if (published.has(entry.key)) continue;
  const audio = inside(sourceRoot, entry.audioFile);
  const timings = inside(sourceRoot, entry.timingsFile);
  if (!statSync(audio).isFile() || !statSync(timings).isFile()) throw new Error(`missing files for ${entry.key}`);
  if (hashFile(audio) !== entry.audioSha256 || hashFile(timings) !== entry.timingsSha256) {
    throw new Error(`hash mismatch for ${entry.key}`);
  }
  selected.push(entry);
  if (selected.length >= limit) break;
}

mkdirSync(outputRoot, { recursive: true });
for (const entry of selected) {
  for (const field of ['audioFile', 'timingsFile']) {
    const target = inside(outputRoot, entry[field]);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(inside(sourceRoot, entry[field]), target);
  }
}
writeFileSync(join(outputRoot, 'manifest.json'), JSON.stringify({
  version: 1,
  generatedAt: source.generatedAt,
  model: source.model,
  aligner: source.aligner,
  entries: selected,
}));
process.stdout.write(`${JSON.stringify({ waveEntries: selected.length, publishedEntries: published.size })}\n`);
