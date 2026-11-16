import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { env } from '../env.js';
import { readPrivateEssayCatalogFile } from '../essay-catalog.js';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: import-private-essay-catalog <catalog.json>');

const source = readPrivateEssayCatalogFile(resolve(inputPath));

const destination = resolve(env.DATA_DIR, 'private-essay-catalog.json');
const temporary = resolve(env.DATA_DIR, `.private-essay-catalog-${process.pid}.tmp`);
try {
  writeFileSync(temporary, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
} finally {
  rmSync(temporary, { force: true });
}

const sentenceCount = source.essays.reduce((total, essay) => total + essay.sentenceCount, 0);
process.stdout.write(`${JSON.stringify({
  imported: true,
  file: basename(destination),
  essays: source.essays.length,
  sentences: sentenceCount,
})}\n`);
