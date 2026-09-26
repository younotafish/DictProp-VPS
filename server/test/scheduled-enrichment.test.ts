import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const readRepoFile = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
  'utf8',
);

test('server search stays immediate while Codex enrichment runs every six hours', () => {
  const workflow = readRepoFile('.github/workflows/incremental-enrichment.yml');
  const launchAgent = readRepoFile('ops/launchd/com.dictprop.incremental-example-enrichment.plist');
  const productionAudit = readRepoFile('server/src/scripts/audit-enrichment.ts');
  const serverAi = readRepoFile('server/src/routes/ai.ts');
  const runner = readRepoFile('scripts/offline/run-incremental-example-enrichment.sh');
  const textGenerators = [
    'scripts/offline/enrich-sentences.mjs',
    'scripts/offline/complete-corpus-fields.mjs',
    'scripts/offline/refine-rejected-image-prompts.mjs',
    'scripts/offline/judge-image-candidates.mjs',
  ].map(readRepoFile);
  const interactiveSearchSurfaces = [
    'components/GlobalSearch.tsx',
    'components/TextAnalyzer.tsx',
    'views/Notebook.tsx',
  ].map(readRepoFile);
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
  assert.match(serverAi, /POST \/api\/analyze/);
  assert.match(serverAi, /proxyFetch/);
  assert.match(launchAgent, /<key>CODEX_MODEL<\/key>\s*<string>gpt-5\.6-sol<\/string>/);
  assert.match(launchAgent, /<key>CODEX_REASONING_EFFORT<\/key>\s*<string>xhigh<\/string>/);
  assert.doesNotMatch(launchAgent, /Qwen3-30B|Qwen3-VL|LOCAL_MLX/);
  assert.match(runner, /complete-corpus-fields\.mjs/);
  assert.match(runner, /prepare-incremental-item-images\.mjs/);
  assert.match(runner, /CODEX_MODEL/);
  assert.match(runner, /CODEX_CONCURRENCY/);
  assert.match(runner, /CODEX_IMAGE_CONCURRENCY/);
  assert.match(runner, /IMAGE_MODEL=ernie-image-turbo/);
  assert.doesNotMatch(runner, /LOCAL_MLX|IPA_CLAUDE|IPA_META|DEEPINFRA_API_KEY/);
  assert.match(runner, /shlock -f "\$LOCK_FILE" -p "\$\$"/);
  assert.match(runner, /analysis-publish-state-coverage-v2/);
  assert.match(runner, /publish-state-coverage-v2/);
  assert.match(runner, /another local image pipeline is active/);
  assert.match(runner, /continuing with incremental images/);
  for (const generator of textGenerators) {
    assert.match(generator, /gpt-5\.6-sol/);
    assert.match(generator, /spawnCodex/);
    assert.match(generator, /--output-schema/);
    assert.doesNotMatch(generator, /createLocalMlxClient|Qwen3/);
  }
  assert.match(textGenerators[3], /abstract, rhetorical, figurative, relational, or logical target/);
  assert.match(textGenerators[3], /do not require the image alone to name the formal concept/);
  for (const surface of interactiveSearchSurfaces) {
    assert.doesNotMatch(surface, /generateIllustration/);
  }
  for (const publisher of recurringPublishers) {
    assert.match(publisher, /wait-for-incremental-enrichment\.sh/);
  }
});
