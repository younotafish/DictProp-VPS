import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../scripts/offline/prepare-incremental-example-source.mjs', import.meta.url));
const sentence = (id: string, textHash = `${id}-hash`) => ({ id, textHash, text: id, lookupHash: `${id}-lookup` });
const source = (sentences: any[]) => ({ version: 1, exportedAt: 1, sentences, stats: {} });

test('incremental example source keeps prior discoveries and adds only non-baseline identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-incremental-examples-'));
  try {
    const currentPath = join(root, 'current.json');
    const baselinePath = join(root, 'baseline.json');
    const previousPath = join(root, 'previous.json');
    const outputPath = join(root, 'output.json');
    writeFileSync(baselinePath, JSON.stringify(source([sentence('baseline')])));
    writeFileSync(previousPath, JSON.stringify(source([sentence('previous')])));
    writeFileSync(currentPath, JSON.stringify(source([
      sentence('baseline'),
      sentence('current'),
      sentence('previous', 'current-version'),
    ])));

    execFileSync(process.execPath, [script, currentPath, baselinePath, outputPath, previousPath]);

    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(output.sentences.map((entry: any) => entry.id), ['current', 'previous']);
    assert.equal(output.sentences[1].textHash, 'previous-hash');
    assert.equal(output.stats.newlyDiscovered, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
