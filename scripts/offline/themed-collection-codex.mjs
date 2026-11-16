// The Codex call the themed-collection tools share (generate- and audit-themed-sentence-collection.mjs).
//
// Every cycle stage reaches its model through structured-model.mjs. These two manual tools still run `codex exec`
// themselves: moving them onto structured-model.mjs would change their reasoning effort and let
// ENRICHMENT_MODEL_PROVIDER switch them to Claude, which is for the owner to decide.
import { killProcessGroup, spawnCodex } from './codex-process.mjs';

/** CODEX_MODEL (default gpt-5.6-sol), and CODEX_TIMEOUT_MINUTES clamped to 5-60 (default 30) per call. */
export function themedCodexSettings(env = process.env) {
  const timeoutMinutes = Math.max(5, Math.min(60, Number(env.CODEX_TIMEOUT_MINUTES || 30)));
  return { model: env.CODEX_MODEL || 'gpt-5.6-sol', timeoutMs: timeoutMinutes * 60 * 1_000 };
}

/**
 * Runs one read-only `codex exec` that writes output matching schemaPath to resultPath. The child stays in
 * activeChildren while it runs, for the caller's signal cleanup; past timeoutMs it gets SIGTERM, then SIGKILL.
 */
export function runThemedCodex({ prompt, schemaPath, resultPath, model, timeoutMs, activeChildren }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCodex([
      'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
      '-m', model, '--output-schema', schemaPath, '-o', resultPath, '-',
    ]);
    activeChildren.add(child);
    let stderr = '';
    let hardKill;
    const timeout = setTimeout(() => {
      killProcessGroup(child, 'SIGTERM');
      hardKill = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 10_000);
    }, timeoutMs);
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on('error', error => {
      activeChildren.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKill);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKill);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex exited with ${code ?? signal}: ${stderr}`));
    });
    child.stdin.end(prompt);
  });
}
