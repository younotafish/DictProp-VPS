import { getAllItems } from '../db.js';
import { corpusSourceHash, type CorpusExportRecord } from '../corpus-audit.js';
import { parseStoredAnalysis } from '../example-enrichment-coverage.js';
import { hasCompleteSentenceAnalysis } from '../sentence-analysis.js';
import { createChunkedWriter } from './support/chunked-writer.js';
import { storedEnrichmentRows } from './support/enrichment-rows.js';
import { requireOwner } from './support/run.js';

// The export is the JSON of { version, exportedAt, items, exampleEnrichmentCoverage }, byte for byte, written a record
// at a time: as one string it would take well over 100 MB beside the parsed library, in the container next to the
// live server on a 2 GB machine.
const owner = requireOwner();
const exportedAt = Date.now();
const out = createChunkedWriter(process.stdout);

await out.write(`{"version":1,"exportedAt":${JSON.stringify(exportedAt)},"items":[`);
let separator = '';
for (const item of getAllItems(owner.id)) {
  if (item.isDeleted) continue;
  const record: CorpusExportRecord = {
    id: item.data.id,
    type: item.type,
    sourceHash: corpusSourceHash(item.data),
    wasArchived: item.isArchived === true,
    savedAt: item.savedAt,
    data: item.data,
  };
  await out.write(`${separator}${JSON.stringify(record)}`);
  separator = ',';
}

const exampleEnrichmentCoverage: Array<{
  lookupHash: string;
  hasAnalysis: boolean;
  hasImage: boolean;
}> = [];
// Malformed and obsolete rows are exported too, as incomplete: the Mac redoes them.
for (const row of storedEnrichmentRows({ byLookupHash: true })) {
  exampleEnrichmentCoverage.push({
    lookupHash: row.lookup_hash,
    hasAnalysis: hasCompleteSentenceAnalysis(parseStoredAnalysis(row.analysis)),
    hasImage: row.image_bytes !== null && row.image_bytes > 0,
  });
}
await out.write(`],"exampleEnrichmentCoverage":${JSON.stringify(exampleEnrichmentCoverage)}}`);
await out.flush();
