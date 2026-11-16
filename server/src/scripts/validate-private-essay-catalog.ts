// Checks a private essay catalog on the Mac with the reader the VPS importer (import-private-essay-catalog.ts) uses,
// readPrivateEssayCatalogFile, so scripts/offline/publish-private-essay-catalog.sh never publishes a catalog production
// would refuse. It prints {"valid":true,"essays":N,"sentences":M}, and exits 1 with the importer's reason when the
// catalog fails. It opens no database. Run it with tsx, as the publisher does:
//   server/node_modules/.bin/tsx server/src/scripts/validate-private-essay-catalog.ts <catalog.json>
import { readPrivateEssayCatalogFile } from '../essay-catalog.js';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: validate-private-essay-catalog <catalog.json>');

const source = readPrivateEssayCatalogFile(inputPath);

process.stdout.write(`${JSON.stringify({
  valid: true,
  essays: source.essays.length,
  sentences: source.essays.reduce((total, essay) => total + essay.sentenceCount, 0),
})}\n`);
