import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflowsDir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const workflows = readdirSync(workflowsDir)
  .filter(name => name.endsWith('.yml'))
  .map(name => ({ name, text: readFileSync(`${workflowsDir}${name}`, 'utf8') }));

/** Splits a workflow into steps: each starts at a "- name:" or "- uses:" list item and runs to the next one. */
const steps = (text: string): string[] => text.split(/\n(?=\s+- (?:name|uses):)/);

test('every action is pinned to a full commit SHA', () => {
  for (const { name, text } of workflows) {
    for (const [, ref] of text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/, `${name}: ${ref}`);
    }
  }
});

test('every SSH and SCP step to the VPS verifies its host key', () => {
  const fingerprints = new Set<string>();
  for (const { name, text } of workflows) {
    const vpsSteps = steps(text).filter(step => /uses: appleboy\/(?:ssh|scp)-action@/.test(step));
    if (vpsSteps.length === 0) continue;
    const declared = text.match(/^env:\n(?:\s+#.*\n)*\s+VPS_SSH_FINGERPRINT: (SHA256:[A-Za-z0-9+/]{43})$/m);
    assert.ok(declared, `${name} declares VPS_SSH_FINGERPRINT at the top level`);
    fingerprints.add(declared[1]);
    for (const step of vpsSteps) {
      assert.match(step, /^\s+fingerprint: \$\{\{ env\.VPS_SSH_FINGERPRINT \}\}$/m, `${name}: ${step.trim().split('\n')[0]}`);
    }
  }
  assert.equal(fingerprints.size, 1, 'every workflow pins the same host key');
});

test('checkouts leave no token behind for later steps', () => {
  for (const { name, text } of workflows) {
    for (const step of steps(text).filter(step => /uses: actions\/checkout@/.test(step))) {
      assert.match(step, /persist-credentials: false/, name);
    }
  }
});
