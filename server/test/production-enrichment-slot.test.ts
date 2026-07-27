import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const waitScript = fileURLToPath(
  new URL('../../scripts/offline/wait-for-incremental-enrichment.sh', import.meta.url),
);

test('offline publishers yield while incremental enrichment is pending or running', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-production-slot-'));
  try {
    const fakeGh = join(root, 'gh');
    const callsPath = join(root, 'calls');
    writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$FAKE_GH_CALLS" 2>/dev/null || echo 0)"
count="$((count + 1))"
printf '%s\n' "$count" > "$FAKE_GH_CALLS"
if [ "$count" -lt 3 ]; then printf 'active\n'; else printf 'idle\n'; fi
`);
    chmodSync(fakeGh, 0o700);

    const result = spawnSync('bash', [waitScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GH_CALLS: callsPath,
        GH_BIN: fakeGh,
        PRODUCTION_SLOT_POLL_SECONDS: '0',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(callsPath, 'utf8').trim(), '3');
    assert.match(result.stderr, /Incremental enrichment owns the next production slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline publishers fail closed when GitHub status is temporarily unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'dictprop-production-slot-error-'));
  try {
    const fakeGh = join(root, 'gh');
    const callsPath = join(root, 'calls');
    writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$FAKE_GH_CALLS" 2>/dev/null || echo 0)"
count="$((count + 1))"
printf '%s\n' "$count" > "$FAKE_GH_CALLS"
if [ "$count" -eq 1 ]; then exit 1; fi
printf 'idle\n'
`);
    chmodSync(fakeGh, 0o700);

    const result = spawnSync('bash', [waitScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GH_CALLS: callsPath,
        GH_BIN: fakeGh,
        PRODUCTION_SLOT_POLL_SECONDS: '0',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(callsPath, 'utf8').trim(), '2');
    assert.match(result.stderr, /Could not query incremental enrichment status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
