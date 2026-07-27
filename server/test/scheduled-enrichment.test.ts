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

  assert.match(workflow, /cron: '23 \*\/6 \* \* \*'/);
  assert.match(workflow, /INCREMENTAL_ENRICHMENT_MAX_RUNTIME_MINUTES=70/);
  assert.match(launchAgent, /<key>StartInterval<\/key>\s*<integer>21600<\/integer>/);
  assert.match(runner, /CODEX_MODEL=gpt-5\.5/);
  assert.match(runner, /shlock -f "\$LOCK_FILE" -p "\$\$"/);
  assert.match(runner, /analysis-publish-state-detailed-v1/);
});
