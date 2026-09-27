#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStructuredModel, runStructuredModel } from './structured-model.mjs';

// A six-hour cycle should stop before it requests a production export when the local model cannot
// answer. One small image-bearing call proves authentication, model access, schemas, and vision input.
const config = resolveStructuredModel();
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
};
const workDir = mkdtempSync(join(tmpdir(), 'dictprop-model-check-'));
const schemaPath = join(workDir, 'schema.json');
const resultPath = join(workDir, 'result.json');
writeFileSync(schemaPath, `${JSON.stringify(schema)}\n`, { mode: 0o600 });
try {
  await runStructuredModel({ ...config, reasoningEffort: 'low' }, {
    prompt: 'This is an automated readiness check. If you can see the attached app icon, return {"ok": true}.',
    schema,
    schemaPath,
    resultPath,
    images: [fileURLToPath(new URL('../../public/pwa-192x192.png', import.meta.url))],
    timeoutMs: 5 * 60 * 1_000,
  });
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  if (result?.ok !== true) throw new Error(`unexpected response ${JSON.stringify(result)}`);
  process.stdout.write(`${config.label} ${config.model} is ready\n`);
} catch (error) {
  process.stderr.write(
    `${config.label} ${config.model} preflight failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
