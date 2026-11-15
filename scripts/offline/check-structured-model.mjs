#!/usr/bin/env node

import { checkModelReady, resolveStructuredModel } from './structured-model.mjs';

// A six-hour cycle should stop before it requests a production export when the local model cannot answer.
const config = resolveStructuredModel();
try {
  await checkModelReady(config);
  process.stdout.write(`${config.label} ${config.model} is ready\n`);
} catch (error) {
  process.stderr.write(
    `${config.label} ${config.model} preflight failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
