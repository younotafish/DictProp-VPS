import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const readRepoFile = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
  'utf8',
);

test('production and local enrichment schedules both run every six hours', () => {
  const workflow = readRepoFile('.github/workflows/incremental-enrichment.yml');
  const launchAgent = readRepoFile('ops/launchd/com.dictprop.incremental-example-enrichment.plist');
  const runner = readRepoFile('scripts/offline/run-incremental-example-enrichment.sh');
  const recurringPublishers = [
    'scripts/offline/dispatch-staged-example-enrichments.sh',
    'scripts/offline/dispatch-staged-example-analyses.sh',
    'scripts/offline/dispatch-staged-saved-sentence-analyses.sh',
  ].map(readRepoFile);

  assert.match(workflow, /cron: '23 \*\/6 \* \* \*'/);
  assert.match(workflow, /INCREMENTAL_ENRICHMENT_MAX_RUNTIME_MINUTES=70/);
  assert.match(launchAgent, /<key>StartInterval<\/key>\s*<integer>21600<\/integer>/);
  assert.match(runner, /CODEX_MODEL=gpt-5\.5/);
  assert.match(runner, /IPA_CLAUDE_CONCURRENCY="\$\{IPA_CLAUDE_CONCURRENCY:-2\}"/);
  assert.match(runner, /IPA_META_CONCURRENCY="\$\{IPA_META_CONCURRENCY:-2\}"/);
  assert.match(runner, /IPA_META_REQUEST_BATCH_SIZE="\$\{IPA_META_REQUEST_BATCH_SIZE:-12\}"/);
  assert.match(runner, /generate-sentence-natural-ipa\.mjs/);
  assert.match(runner, /apply-reviewed-natural-ipa\.mjs/);
  assert.match(runner, /shlock -f "\$LOCK_FILE" -p "\$\$"/);
  assert.match(runner, /analysis-publish-state-detailed-v1/);
  for (const publisher of recurringPublishers) {
    assert.match(publisher, /wait-for-incremental-enrichment\.sh/);
  }
});
