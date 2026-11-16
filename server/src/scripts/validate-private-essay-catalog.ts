// Checks a private essay catalog on the Mac with the checks the VPS importer (import-private-essay-catalog.ts) applies,
// so scripts/offline/publish-private-essay-catalog.sh never publishes a catalog production would refuse. It prints
// {"valid":true,"essays":N,"sentences":M}, and exits 1 with the importer's reason when the catalog fails. It opens no
// database. Run it with tsx, as the publisher does:
//   server/node_modules/.bin/tsx server/src/scripts/validate-private-essay-catalog.ts <catalog.json>
import { readFileSync } from 'node:fs';
import { validatePrivateEssayCatalog, type RawEssayCatalog } from '../essay-catalog.js';

// The importer refuses a file that is empty or larger than this.
const MAX_CATALOG_BYTES = 25 * 1024 * 1024;

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: validate-private-essay-catalog <catalog.json>');

const input = readFileSync(inputPath);
if (input.length === 0 || input.length > MAX_CATALOG_BYTES) {
  throw new Error('Private essay catalog size is invalid');
}
const source = JSON.parse(input.toString('utf8')) as RawEssayCatalog;
validatePrivateEssayCatalog(source);

process.stdout.write(`${JSON.stringify({
  valid: true,
  essays: source.essays.length,
  sentences: source.essays.reduce((total, essay) => total + essay.sentenceCount, 0),
})}\n`);
