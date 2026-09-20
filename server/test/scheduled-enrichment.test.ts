import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const readRepoFile = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
  'utf8',
);

test('production audits and the fully local enrichment worker both run every six hours', () => {
  const workflow = readRepoFile('.github/workflows/incremental-enrichment.yml');
  const launchAgent = readRepoFile('ops/launchd/com.dictprop.incremental-example-enrichment.plist');
  const productionAudit = readRepoFile('server/src/scripts/audit-enrichment.ts');
  const runner = readRepoFile('scripts/offline/run-incremental-example-enrichment.sh');
  const recurringPublishers = [
    'scripts/offline/dispatch-staged-example-enrichments.sh',
    'scripts/offline/dispatch-staged-example-analyses.sh',
    'scripts/offline/dispatch-staged-saved-sentence-analyses.sh',
  ].map(readRepoFile);

  assert.match(workflow, /cron: '23 \*\/6 \* \* \*'/);
  assert.match(workflow, /audit-enrichment\.js/);
  assert.doesNotMatch(workflow, /enrich-new-items\.js/);
  assert.match(workflow, /capture_stdout: true/);
  assert.match(workflow, /Report content coverage/);
  assert.match(workflow, /Alert when local enrichment has outstanding work/);
  assert.match(productionAudit, /summarizeExampleEnrichmentCoverage/);
  assert.match(productionAudit, /mode: 'audit-only'/);
  assert.doesNotMatch(productionAudit, /generateImage|generateSentenceAnalysis|generateAnalysisData/);
  assert.match(launchAgent, /<key>StartInterval<\/key>\s*<integer>21600<\/integer>/);
  assert.match(launchAgent, /Qwen3-30B-A3B-Instruct-2507-4bit/);
  assert.match(launchAgent, /Qwen3-VL-8B-Instruct-4bit/);
  assert.match(runner, /complete-corpus-fields\.mjs/);
  assert.match(runner, /prepare-incremental-item-images\.mjs/);
  assert.match(runner, /LOCAL_MLX_CONCURRENCY/);
  assert.doesNotMatch(runner, /CODEX_MODEL|IPA_CLAUDE|IPA_META|DEEPINFRA_API_KEY/);
  assert.match(runner, /shlock -f "\$LOCK_FILE" -p "\$\$"/);
  assert.match(runner, /analysis-publish-state-coverage-v2/);
  assert.match(runner, /publish-state-coverage-v2/);
  assert.match(runner, /another local image pipeline is active/);
  assert.match(runner, /continuing with incremental images/);
  for (const publisher of recurringPublishers) {
    assert.match(publisher, /wait-for-incremental-enrichment\.sh/);
  }
});
