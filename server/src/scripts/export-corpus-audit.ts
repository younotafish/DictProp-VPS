import { getAllItems } from '../db.js';
import { corpusSourceHash, type CorpusExportRecord } from '../corpus-audit.js';
import { parseStoredAnalysis } from '../example-enrichment-coverage.js';
import { hasCompleteSentenceAnalysis } from '../sentence-analysis.js';
import { storedEnrichmentRows } from './support/enrichment-rows.js';
import { requireOwner } from './support/run.js';

const owner = requireOwner();

const items: CorpusExportRecord[] = getAllItems(owner.id)
  .filter(item => !item.isDeleted)
  .map(item => ({
    id: item.data.id,
    type: item.type,
    sourceHash: corpusSourceHash(item.data),
    wasArchived: item.isArchived === true,
    savedAt: item.savedAt,
    data: item.data,
  }));

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

process.stdout.write(JSON.stringify({
  version: 1,
  exportedAt: Date.now(),
  items,
  exampleEnrichmentCoverage,
}));
