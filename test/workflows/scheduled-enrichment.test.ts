import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { readRepoFile } from '../support/paths.ts';

test('server search stays immediate while local Claude Opus enrichment runs every six hours', () => {
  const workflow = readRepoFile('.github/workflows/incremental-enrichment.yml');
  const launchAgent = readRepoFile('ops/launchd/com.dictprop.incremental-example-enrichment.plist');
  const serverAi = readRepoFile('server/src/routes/ai.ts');
  const runner = readRepoFile('scripts/offline/run-incremental-example-enrichment.sh');
  const structuredModel = readRepoFile('scripts/offline/structured-model.mjs');

  assert.match(workflow, /cron: '23 \*\/6 \* \* \*'/);
  assert.match(workflow, /audit-enrichment\.js/);
  assert.match(workflow, /capture_stdout: true/);
  assert.match(workflow, /Report content coverage/);
  assert.match(workflow, /Alert when local enrichment has stalled/);
  // A non-zero exit loses ssh-action's captured output, so only the report decides the alert.
  assert.match(workflow, /audit-enrichment\.js \|\| true/);
  assert.match(workflow, /jq -e '\.stall\.alerts \| length == 0'/);
  assert.match(workflow, /group: dictprop-production-read/);
  assert.match(launchAgent, /<key>StartInterval<\/key>\s*<integer>21600<\/integer>/);
  assert.match(serverAi, /POST \/api\/analyze/);
  assert.match(serverAi, /proxyFetch/);
  assert.doesNotMatch(launchAgent, /Qwen3-30B|Qwen3-VL|LOCAL_MLX/);
  // A loaded job keeps its environment until it is reloaded, so every setting but PATH is a runner default,
  // which a new value reaches without a reload. The model choice lives there.
  const environment = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(launchAgent)?.[1] ?? '';
  assert.deepEqual([...environment.matchAll(/<key>([^<]+)<\/key>/g)].map(match => match[1]), ['PATH']);
  assert.match(runner, /ENRICHMENT_MODEL_PROVIDER="\$\{ENRICHMENT_MODEL_PROVIDER:-claude\}"/);
  assert.match(runner, /CLAUDE_MODEL="\$\{CLAUDE_MODEL:-claude-opus-5-5\}"/);
  assert.match(runner, /CLAUDE_REASONING_EFFORT="\$\{CLAUDE_REASONING_EFFORT:-xhigh\}"/);
  assert.match(runner, /CODEX_MODEL="\$\{CODEX_MODEL:-gpt-5\.6-sol\}"/);
  assert.match(runner, /CODEX_REASONING_EFFORT="\$\{CODEX_REASONING_EFFORT:-xhigh\}"/);
  assert.match(runner, /complete-corpus-fields\.mjs/);
  assert.match(runner, /prepare-incremental-item-images\.mjs/);
  assert.match(runner, /export ENRICHMENT_MODEL_PROVIDER CLAUDE_MODEL CLAUDE_REASONING_EFFORT CODEX_MODEL/);
  assert.match(runner, /check-structured-model\.mjs/);
  assert.match(runner, /ANALYSIS_CONCURRENCY="\$\{ANALYSIS_CONCURRENCY:-16\}"/);
  assert.match(runner, /IMAGE_QA_CONCURRENCY="\$\{IMAGE_QA_CONCURRENCY:-8\}"/);
  assert.match(runner, /CODEX_IMAGE_CONCURRENCY="\$IMAGE_QA_CONCURRENCY"/);
  assert.match(runner, /IMAGE_MODEL="\$\{IMAGE_MODEL:-krea2\}"/);
  // A few unrenderable images must not hold back the accepted ones.
  assert.match(runner, /IMAGE_MAX_CANDIDATES="\$\{IMAGE_MAX_CANDIDATES:-8\}"/);
  assert.match(runner, /if \[ "\$ITEM_IMAGE_READY" -gt 0 \]/);
  assert.doesNotMatch(runner, /LOCAL_MLX|IPA_CLAUDE|IPA_META|DEEPINFRA_API_KEY/);
  assert.match(runner, /shlock -f "\$LOCK_FILE" -p "\$\$"/);
  assert.match(runner, /analysis-publish-state-coverage-v2/);
  assert.match(runner, /publish-state-coverage-v2/);
  assert.match(runner, /another local image pipeline is active/);
  assert.match(structuredModel, /claude-opus-5-5/);
  assert.match(structuredModel, /--json-schema/);
  assert.match(structuredModel, /gpt-5\.6-sol/);
  assert.match(structuredModel, /--output-schema/);
  assert.doesNotMatch(structuredModel, /--bare/);
});

test('scheduled sentence analysis spreads each stage over every worker', () => {
  const runner = readRepoFile('scripts/offline/run-incremental-example-enrichment.sh');
  const helper = runner.match(/^sentence_batch_size\(\) \{\n[\s\S]*?\n\}$/m)?.[0];
  assert.ok(helper);
  const sizes = execFileSync('bash', ['-c', `${helper}\nfor count in 1 2 16 17 30 48 49 500; do sentence_batch_size "$count"; done`], {
    encoding: 'utf8',
    env: { ...process.env, ANALYSIS_CONCURRENCY: '16', SENTENCE_ANALYSIS_BATCH_SIZE: '4' },
  }).trim().split('\n').map(Number);

  // A small stage sends one sentence per request; a large one still amortizes the prompt over four.
  assert.deepEqual(sizes, [1, 1, 1, 2, 2, 3, 4, 4]);
});
